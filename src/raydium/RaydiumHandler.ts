import {SwapHandler, TradeEvent} from "../../common/interfaces/interfaces";
import RaydiumSwap from "./RaydiumSwap";
import WalletTracker from "../../services/walletTracker/src/WalletTracker";
import {formatPortfolioTable, getTokenDecimals, retryOperation} from "../../common/utils";
import logger from "../../common/logging/LoggerManager"
import {LAMPORTS_PER_SOL} from "@solana/web3.js";
import {JUPITER_AGGREGATOR, SOLANA_ADDRESS} from "../../constants/constants";
require('dotenv').config();

class RaydiumHandler implements SwapHandler {
    programIds = new Set([RaydiumSwap.RAYDIUM_V4_PROGRAM_ID]);
    jupiterProgramIds = new Set([JUPITER_AGGREGATOR]);

    constructor(
        private walletTracker: WalletTracker,
        private raydiumSwap: RaydiumSwap,
        private slippage: number,
        private priorityFeeSol: number,
        private jitoFeeSol: number,
        private tradeAmountSol: number
    ) {
    }

    canHandle(accountKeys: string[]): boolean {
        const hasRaydium = accountKeys.some((k) => this.programIds.has(k));
        const hasJupiter = accountKeys.some((k) => this.jupiterProgramIds.has(k));

        return hasRaydium && !hasJupiter;
    }

    async parseEvent(result: any, user: string): Promise<TradeEvent | null> {
        const mintAddress = this.raydiumSwap.getMintAddress(result, user);
        const type = this.raydiumSwap.checkIfSellOrBuy(result);
        if (type === 'unknown') return null;

        const decimals = await getTokenDecimals(mintAddress);
        const [solAmount, tokenAmount] = this.raydiumSwap.findSwapAmounts(
            result,
            type,
            user,
            decimals
        );
        return this.raydiumSwap.formatRaydiumTradeEvent(
            mintAddress,
            user,
            type,
            [solAmount, tokenAmount]
        );
    }

    async executeSwap(event: TradeEvent): Promise<void> {
        let partialBotAmount: number;
        let amountToSell: number;

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

        const poolInfo = await this.raydiumSwap.findRelevantPoolInfo(event.mint);
        const side: 'in' | 'out' = event.isBuy ? 'in' : 'out';

        if (!event.isBuy) {
            amountToSell =
                this.walletTracker.calculateSellProportion(
                    partialBotAmount,
                    this.walletTracker.myPortfolio[txnObj.asset].amount,
                    parseFloat(txnObj.amount)
                );
        }
        const rawTxn = await this.raydiumSwap.getSwapTransaction(
            side === 'in' ? event.mint : SOLANA_ADDRESS,
            side === 'in' ? this.tradeAmountSol : amountToSell,
            poolInfo!,
            this.priorityFeeSol * LAMPORTS_PER_SOL,
            false,
            side,
            this.slippage,
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

        const [mySol, myToken] = this.raydiumSwap.findSwapAmounts(
            info,
            side === 'in' ? 'buy' : 'sell',
            process.env.PUBLIC_KEY!,
            await getTokenDecimals(event.mint)
        );

        const myEvent = this.raydiumSwap.formatRaydiumTradeEvent(
            event.mint,
            process.env.PUBLIC_KEY!,
            side === 'in' ? 'buy' : 'sell',
            [mySol, myToken]
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
export default RaydiumHandler
