import {SwapHandler, TradeEvent} from "../../common/interfaces/interfaces";
import {JUPITER_AGGREGATOR} from "../../constants/constants";
import WalletTracker from "../../services/walletTracker/src/WalletTracker";
import JupiterSwap from "./JupiterSwap";
import logger from "../../common/logging/LoggerManager";
import {LAMPORTS_PER_SOL} from "@solana/web3.js";
import {formatPortfolioTable, getTokenDecimals, retryOperation} from "../../common/utils";


class JupiterHandler implements SwapHandler {
    programIds = new Set([JUPITER_AGGREGATOR]);

    constructor(
        private walletTracker: WalletTracker,
        private jupiterSwap: JupiterSwap,
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
        return this.jupiterSwap.getJupiterDataToDecode(result, user);
    }

    async executeSwap(event: TradeEvent): Promise<void> {
        let partialBotAmount: number;
        let amountToSell: number;
        let decimals: number;

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

        const side: 'in' | 'out' = event.isBuy ? 'in' : 'out';
        if (!event.isBuy) {
            amountToSell =
                this.walletTracker.calculateSellProportion(
                    partialBotAmount,
                    this.walletTracker.myPortfolio[txnObj.asset].amount,
                    parseFloat(txnObj.amount)
                );

            decimals = await retryOperation(
                () => getTokenDecimals(event.mint),
                10,
                500);
        }
        const rawTxn = await this.jupiterSwap.composeJupiterTransaction(
            event.isBuy,
            event.mint,
            side === 'in' ? this.tradeAmountSol * LAMPORTS_PER_SOL : (amountToSell) * 10 ** decimals,
            this.slippage,
            this.priorityFeeSol,
            this.jitoFeeSol,
            side
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

        const myEvent: TradeEvent = await this.jupiterSwap.getJupiterDataToDecode(
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
export default JupiterHandler
