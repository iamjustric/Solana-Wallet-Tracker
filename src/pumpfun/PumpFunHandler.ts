import {SwapHandler, TradeEvent} from "../../common/interfaces/interfaces";
import {PUMP_FUN_PROGRAM_ID} from "../../constants/constants";
import WalletTracker from "../../services/walletTracker/src/WalletTracker";
import PumpFunSwap from "./PumpFunSwap";
import logger from "../../common/logging/LoggerManager";
import {formatPortfolioTable, number_to_decimals, retryOperation} from "../../common/utils";
import {LAMPORTS_PER_SOL} from "@solana/web3.js";


class PumpFunHandler implements SwapHandler {
    programIds = new Set([PUMP_FUN_PROGRAM_ID]);

    constructor(
        private walletTracker: WalletTracker,
        private pumpFunSwap: PumpFunSwap,
        private slippage: number,
        private priorityFeeSol: number,
        private jitoFeeSol: number,
        private tradeAmountSol: number
    ) {
    }

    canHandle(accountKeys: string[]): boolean {
        return accountKeys.some((k) => this.programIds.has(k));
    }

    parseEvent(result: any, user: string): Promise<TradeEvent | null> {
        return this.pumpFunSwap.getDataToDecode(result, user);
    }

    async executeSwap(event: TradeEvent): Promise<void> {
        let partialBotAmount: number;
        let amountToSell: number;
        let decimals: number = 6; //PumpFun token always 6 decimals

        const txnObj = this.walletTracker.createTransactionObject(event);
        if (this.walletTracker.botPortfolio[txnObj.asset])
            partialBotAmount = this.walletTracker.botPortfolio[txnObj.asset].amount;

        const botPort = this.walletTracker.updatePortfolio(
            this.walletTracker.botPortfolio,
            txnObj
        );
        if (!Object.keys(botPort).length) {
            logger.warn(`Token non in portfolio bot: ${event.mint}`);
            return;
        }

        const projectInfo = await retryOperation(
            () => this.pumpFunSwap.getProjectInfo(event.mint),
            10,
            500
        );
        if (!projectInfo) return

        const side: 'in' | 'out' = event.isBuy ? 'in' : 'out';

        if (!event.isBuy) {
            amountToSell =
                this.walletTracker.calculateSellProportion(
                    partialBotAmount,
                    this.walletTracker.myPortfolio[txnObj.asset].amount,
                    parseFloat(txnObj.amount)
                );
        }
        const rawTxn = await this.pumpFunSwap.getPumpFunTransaction(
            projectInfo,
            side === 'in' ? this.tradeAmountSol * LAMPORTS_PER_SOL : number_to_decimals(amountToSell, decimals),
            this.slippage,
            side,
            this.priorityFeeSol,
            this.jitoFeeSol
        );

        const txId = await retryOperation(
            () => this.walletTracker.sendJitoTransaction(rawTxn, side),
            5,
            1000
        );

        const info = await retryOperation(
            () => this.walletTracker.getTransactionInfo(txId, process.env.RPC_URL!),
            20,
            500
        );

        const myEvent: TradeEvent = await this.pumpFunSwap.getDataToDecode(
            info,
            process.env.PUBLIC_KEY as string
        );

        const myTxnObj = this.walletTracker.createTransactionObject(myEvent);

        const myPort = this.walletTracker.updatePortfolio(
            this.walletTracker.myPortfolio,
            myTxnObj
        );

        logger.info(`Bot Portfolio:\n${formatPortfolioTable(botPort, 28)}`);
        logger.info(`My Portfolio:\n${formatPortfolioTable(myPort, 28)}`);
    }

}
export default PumpFunHandler
