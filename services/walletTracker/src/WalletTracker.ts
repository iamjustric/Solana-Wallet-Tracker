import {Connection, Transaction as LegacyTransaction, TransactionInstruction, PartiallyDecodedInstruction} from "@solana/web3.js";
import WebSocket from "ws";
import {jitoEndpoints} from "../../../constants/constants";
import RaydiumSwap from "../../../src/raydium/RaydiumSwap";
import PumpFunSwap from "../../../src/pumpfun/PumpFunSwap";
import base58 from 'bs58'
import JupiterSwap from "../../../src/jupiter/JupiterSwap";
import logger from "../../../common/logging/LoggerManager"
import * as fs from 'fs';
import {Portfolio, Transaction, TradeEvent} from "../../../common/interfaces/interfaces";
import {getUnixTime, sleep} from "../../../common/utils";
require('dotenv').config();

class WalletTracker {
    connection: Connection
    botPortfolio: Portfolio;
    myPortfolio: Portfolio;
    raydiumSwap: RaydiumSwap;
    pumpFunSwap: PumpFunSwap
    jupiterSwap: JupiterSwap

    constructor(RPC_URL: string, WSS_ENDPOINT: string, PRIVATE_KEY: string, botPortfolio: Portfolio, myPortfolio: Portfolio) {
        this.connection = new Connection(RPC_URL, {wsEndpoint: WSS_ENDPOINT});
        this.botPortfolio = botPortfolio;
        this.myPortfolio = myPortfolio;
        this.raydiumSwap = new RaydiumSwap(RPC_URL, PRIVATE_KEY);
        this.pumpFunSwap = new PumpFunSwap(RPC_URL, PRIVATE_KEY);
        this.jupiterSwap = new JupiterSwap(RPC_URL, PRIVATE_KEY)

        this.loadPortfolioState();
    }

    savePortfolioState() {
        const state = {
            botPortfolio: this.botPortfolio,
            myPortfolio: this.myPortfolio,
        };
        fs.writeFileSync('portfolioState.json', JSON.stringify(state, null, 4), 'utf8');
    }

    loadPortfolioState() {
        if (fs.existsSync('portfolioState.json')) {
            const state = JSON.parse(fs.readFileSync('portfolioState.json', 'utf8'));
            this.botPortfolio = state.botPortfolio || {};
            this.myPortfolio = state.myPortfolio || {};
        }
    }

    sendRequest(ws: WebSocket, addresses: string[]) {
        const request = {
            jsonrpc: "2.0",
            id: 420,
            method: "transactionSubscribe",
            params: [
                {
                    failed: false,
                    accountInclude: addresses
                },
                {
                    commitment: "confirmed",
                    encoding: "jsonParsed",
                    transactionDetails: "full",
                    maxSupportedTransactionVersion: 0
                }
            ]
        };
        ws.send(JSON.stringify(request));
    }

    createTransactionObject(tradeEvent: TradeEvent): Transaction {
        return {
            type: tradeEvent.isBuy ? 'buy' : 'sell',
            asset: tradeEvent.mint,
            amount: String(tradeEvent.tokenAmount),
            price: String(tradeEvent.solAmount)
        }
    }

    updatePortfolio(portfolio: Portfolio, transaction: Transaction): Portfolio {
        if (transaction.type === 'buy') {
            if (!portfolio[transaction.asset]) {
                portfolio[transaction.asset] = {asset: transaction.asset, amount: 0};
            }
            portfolio[transaction.asset].amount += parseFloat(transaction.amount.toString());
        } else if (transaction.type === 'sell') {
            if (portfolio[transaction.asset]) {
                portfolio[transaction.asset].amount -= parseFloat(transaction.amount.toString());
                if (portfolio[transaction.asset].amount < 0) {
                    portfolio[transaction.asset].amount = 0;
                }
            }
        }

        this.savePortfolioState();
        return portfolio;
    }

    calculateSellProportion(botAmount: number, myAmount: number, botSoldAmount: number): number {
        if (botSoldAmount > botAmount) return Math.floor(myAmount)
        const proportion = botSoldAmount / botAmount;
        return Math.floor(myAmount * proportion);
    }

    async getTransactionInfo(address: string, rpcUrl: string) {
        const request = {
            jsonrpc: "2.0",
            id: 1,
            method: "getTransaction",
            params: [
                address,
                {
                    commitment: "confirmed",
                    encoding: "jsonParsed",
                    maxSupportedTransactionVersion: 0
                }
            ]
        };

        try {
            const response = await fetch(rpcUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(request)
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data: any = await response.json();
            if (!data?.result) {
                throw new Error('Null or undefined, retrying...');
            }
            return data.result;
        } catch (error) {
            throw new Error('Error in the JSON-RPC request: ' + error.message);
        }
    }

    async sendJitoTransaction(tx: any, side: 'in' | 'out') {
        const startTime = getUnixTime();
        const {confirmed, signature, error} = await this.jito_executeAndConfirm(tx)
        if (confirmed) {
            logger.info(`Execution time ${signature} ${getUnixTime() - startTime}`)
            side === 'in' ? logger.info(`Buy transaction confirmed: https://solscan.io/tx/${signature}`) :
                logger.info(`Sell transaction confirmed: https://solscan.io/tx/${signature}`);
            return signature
        } else {
            logger.error('Transaction failed to confirm')
            throw new Error(error)
        }
    }

    async jito_executeAndConfirm(transaction: LegacyTransaction) {
        try {
            const serializedTransaction = base58.encode(transaction.serialize());
            let done = false;
            const requests = await this.sendJitoBundles(serializedTransaction);
            (async () => {
                while (!done) {
                    this.sendJitoBundles(serializedTransaction);
                    await sleep(200);
                }
            })();
            const res = await Promise.all(requests.map((p) => p.catch((e) => e)));

            const success_res = res.filter((r) => !(r instanceof Error));
            if (success_res.length > 0) {
                const signature = transaction.signatures[0].signature;
                const txnResponse = await this.jito_confirm(base58.encode(signature));
                if (txnResponse.confirmed) done = true
                return txnResponse
            } else {
                logger.error('Failed to send transaction to any Jito endpoint')
                return {confirmed: false, signature: null, error: 'Failed to send transaction to any Jito endpoint'};
            }
        } catch (e) {
            logger.error(`Error in jito_executeAndConfirm: ${e}`)
            return {confirmed: false, signature: null, error: 'Error in jito_executeAndConfirm'};
        }
    }

    async sendJitoBundles(serializedTransaction: string) {
        const requests = jitoEndpoints.map((url) =>
            fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "sendBundle",
                    params: [[serializedTransaction]],
                })
            })
        )
        return requests;
    }

    async jito_confirm(signature: string) {
        let timeout: number = 3 * 60 * 300; //1 minute~
        let error: string | null = null
        try {
            const start = Date.now();
            let confirmed = false;
            let pollAttempts = 0;

            while (!confirmed && (Date.now() - start) < timeout) {
                const response = await this.connection.getSignatureStatus(signature);

                if (response && response.value && response.value.confirmationStatus === "confirmed") { //Commitment.
                    confirmed = true;
                } else {
                    pollAttempts += 1;
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }

            if (!confirmed) {
                error = 'Transaction confirmation timed out.'
            }

            return {confirmed, signature, error};
        } catch (e) {
            logger.error(`Error confirming transaction: ${e}`)
            error = e.message
            return {confirmed: false, signature, error};
        }
    }
}

export default WalletTracker
