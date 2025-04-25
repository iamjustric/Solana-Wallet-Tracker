import RaydiumSwap from "../../../src/raydium/RaydiumSwap";
import WalletTracker from "./WalletTracker";
import WebSocket from "ws";
import {SwapHandler, TradeEvent} from "../../../common/interfaces/interfaces";
import RaydiumHandler from "../../../src/raydium/RaydiumHandler";
import logger from '../../../common/logging/LoggerManager'
import chalk from "chalk";
import {BANNER_1} from "../../../constants/constants";
import JupiterHandler from "../../../src/jupiter/JupiterHandler";
import JupiterSwap from "../../../src/jupiter/JupiterSwap";
import PumpFunHandler from "../../../src/pumpfun/PumpFunHandler";
import PumpFunSwap from "../../../src/pumpfun/PumpFunSwap";
import fs from "fs";
require('dotenv').config();

const tracker = async (walletAddresses: string[]) => {
    const raydiumSwap = new RaydiumSwap(
        process.env.RPC_URL as string,
        process.env.PRIVATE_KEY as string
    );

    const jupiterSwap = new JupiterSwap(
        process.env.RPC_URL as string,
        process.env.PRIVATE_KEY as string
    );

    const pumpFunSwap = new PumpFunSwap(
        process.env.RPC_URL as string,
        process.env.PRIVATE_KEY as string
    );

    const walletTracker = new WalletTracker(
        process.env.RPC_URL as string,
        process.env.WSS_ENDPOINT as string,
        process.env.PRIVATE_KEY as string,
        {},
        {}
    );

    let ws = new WebSocket(process.env.ENHANCED_WSS as string);

    //GENERAL SETTINGS:
    const priorityFee: number = Number(process.env.PRIORITY_FEE_IN_SOL)
    const jitoFee: number = Number(process.env.JITO_FEE_IN_SOL)
    const amount: number = Number(process.env.AMOUNT)
    const slippageSettings = {
        raydium: Number(process.env.RAYDIUM_SLIPPAGE),
        pumpFun: Number(process.env.PUMPFUN_SLIPPAGE),
        jupiter: Number(process.env.JUPITER_SLIPPAGE),
    };

    const handlers: SwapHandler[] = [
        new RaydiumHandler(
            walletTracker,
            raydiumSwap,
            slippageSettings.raydium,
            priorityFee,
            jitoFee,
            amount
        ),
        new JupiterHandler(
            walletTracker,
            jupiterSwap,
            slippageSettings.jupiter,
            priorityFee,
            jitoFee,
            amount
        ),
        new PumpFunHandler(
            walletTracker,
            pumpFunSwap,
            slippageSettings.pumpFun,
            priorityFee,
            jitoFee,
            amount
        )
    ];

    ws.on('open', function open() {
        logger.info('WS Opened')
        walletTracker.sendRequest(ws, walletAddresses);
    });

    ws.on('error', function error(err) {
        logger.error('WebSocket error:' + err);
    });

    ws.on('close', function close() {
        logger.warn('WS Closed. Reconnecting...')
        ws.removeAllListeners();
        setTimeout(() => tracker(walletAddresses), 1000);
    });

    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data.toString());
            const result = msg.params.result;
            const accountKeys = result.transaction.transaction.message.accountKeys.map(
                (a: any) => a.pubkey
            );
            const user = accountKeys[0];

            for (const h of handlers) {
                if (!h.canHandle(accountKeys)) continue;

                const signature: string = result.signature;
                logger.info(`New Swap, wallet: ${user}, signature: ${signature}`)

                const event: TradeEvent = await h.parseEvent(result, user);
                if (!event) return;
                await h.executeSwap(event);
                break;
            }
        } catch (e) {
            if (e.message.includes("reading 'result'") || e.message.includes("reading 'signature'")) {

            } else {
                logger.error('App error: ' + e)
            }
        }
    });
}

const printInitialInfo = () => {
    console.log(chalk.blue.bold(BANNER_1));
    logger.info(`Welcome Ric, It's time to track some wallets...`)

    process.on('uncaughtException', function (err) {
        console.error('Unhandled Exception:', err);
    });
};

const getWalletList = () => {
    const wallets: string = fs.readFileSync('wallet_list.txt', 'utf8');
    return wallets.trim().split('\n').map(line => line.trim())
};

printInitialInfo()
tracker(getWalletList())
