import {
    Connection,
    Keypair,
    LAMPORTS_PER_SOL,
    PartiallyDecodedInstruction,
    SystemProgram, TokenBalance,
    Transaction,
    VersionedTransaction
} from "@solana/web3.js";
import fetch from 'cross-fetch';
import { Wallet } from '@project-serum/anchor';
import base58 from 'bs58'
import logger from '../../common/logging/LoggerManager'
import {TradeEvent} from "../../common/interfaces/interfaces";
import {JUPITER_AGGREGATOR, SOLANA_ADDRESS} from "../../constants/constants";
import {base64} from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import {getUnixTime, handle_decimals, sleep, getRandomValidator, getTokenDecimals, awaitTransactionSignatureConfirmation} from "../../common/utils";
const anchor = require('@project-serum/anchor');

class JupiterSwap {

    connection: Connection
    wallet: Wallet

    constructor(RPC_URL: string, WALLET_PRIVATE_KEY: string) {
        this.connection = new Connection(RPC_URL, {commitment: 'confirmed'})
        this.wallet = new Wallet(Keypair.fromSecretKey(base58.decode(WALLET_PRIVATE_KEY)))
    }

    async getJupiterDataToDecode(txnInfo: any, user: string): Promise<TradeEvent> {
        let results = [];
        const innerInstructions = txnInfo.transaction?.meta?.innerInstructions || txnInfo.meta?.innerInstructions;
        if (!innerInstructions) return null
        for (let i = 0; i < innerInstructions.length; i++) {
            const instructions = innerInstructions[i].instructions;

            for (let j = 0; j < instructions.length; j++) {
                const instruction = instructions[j] as PartiallyDecodedInstruction;

                if (instruction.programId.toString() === JUPITER_AGGREGATOR && instruction?.data) {
                    results.push(instruction?.data);
                }
            }
        }
        const decodedList = this.decodeJupiterTransaction(results)
        const formattedList = await this.formatJupiterTradeEvent(decodedList, user, txnInfo)
        return formattedList
    }

    decodeJupiterTransaction(dataList: string[]) {
        let decodedList: any[] = []
        for (let i = 0; i < dataList.length; i++) {
            let base58Data: string = dataList[i];
            let buffer = Buffer.from(base58.decode(base58Data));
            buffer = buffer.slice(8);
            const IDLJupiter = require('../../services/IDL/idl-jupiter.json');
            let coderJ = new anchor.BorshCoder(IDLJupiter);
            let args = coderJ.events.decode(base64.encode(buffer));
            if (args.name === 'SwapEvent') decodedList.push(args)
        }

        return decodedList
    }

    async formatJupiterTradeEvent(decodedTxn: {
        name: string,
        data: any
    }[], user: string, txnInfo: any): Promise<TradeEvent> {
        if (decodedTxn.length === 1) {
            const isBuy: boolean = decodedTxn[0].data.inputMint.toString() === SOLANA_ADDRESS;
            const mintAddress = isBuy ? decodedTxn[0].data.outputMint.toString() : decodedTxn[0].data.inputMint.toString()
            const decimals: number = await getTokenDecimals(mintAddress);
            return {
                mint: mintAddress,
                user: user,
                isBuy: isBuy,
                solAmount: isBuy ? Number(decodedTxn[0].data.inputAmount.toString()) / 10 ** 9 : Number(decodedTxn[0].data.outputAmount.toString()) / 10 ** 9,
                tokenAmount: isBuy ? Number(decodedTxn[0].data.outputAmount.toString()) / 10 ** decimals : Number(decodedTxn[0].data.inputAmount.toString()) / 10 ** decimals
            }
        } else {
            const preTokenBalances = txnInfo.transaction?.meta?.preTokenBalances || txnInfo.meta?.preTokenBalances as Array<TokenBalance>
            const preBalance = preTokenBalances?.find((balance) => balance.mint !== SOLANA_ADDRESS && balance.owner === user) as TokenBalance
            const tokenTarget: string = preBalance.mint;
            const decimals: number = await getTokenDecimals(tokenTarget);
            return this.findFinalJupiterSwap(decodedTxn, tokenTarget, decimals, user)
        }
    }

    findFinalJupiterSwap(events: {
        name: string,
        data: any
    }[], targetTokenAddress: string, decimals: number, user: string) {
        let filteredEvents = events.filter(event => {
            return (event.data.inputMint?.toString() === SOLANA_ADDRESS || event.data.outputMint?.toString() === SOLANA_ADDRESS) &&
                (event.data.inputMint?.toString() === targetTokenAddress || event.data.outputMint?.toString() === targetTokenAddress);
        });

        if (!filteredEvents.length) {
            return this.handleMultipleEvents(events, targetTokenAddress, decimals, user)
        }

        if (filteredEvents.length === 1) {
            const isBuy = filteredEvents[0].data.inputMint.toString() === SOLANA_ADDRESS
            return {
                mint: targetTokenAddress,
                user: user,
                isBuy: isBuy,
                solAmount: isBuy ? handle_decimals(filteredEvents[0].data.inputAmount, 9) : handle_decimals(filteredEvents[0].data.outputAmount, 9),
                tokenAmount: isBuy ? handle_decimals(filteredEvents[0].data.outputAmount, decimals) : handle_decimals(filteredEvents[0].data.inputAmount, decimals),
            }
        }

        if (filteredEvents.length > 1) {
            let totalSolAmount = 0;
            let totalTokenAmount = 0;

            filteredEvents.forEach(event => {
                const solInInput = event.data.inputMint.toString() === SOLANA_ADDRESS;
                const tokenInInput = event.data.inputMint.toString() === targetTokenAddress;

                if (solInInput) {
                    totalSolAmount += handle_decimals(event.data.inputAmount, 9);
                } else {
                    totalSolAmount += handle_decimals(event.data.outputAmount, 9);
                }

                if (tokenInInput) {
                    totalTokenAmount += handle_decimals(event.data.inputAmount, decimals);
                } else {
                    totalTokenAmount += handle_decimals(event.data.outputAmount, decimals);
                }
            });

            const isBuy = filteredEvents[0].data.inputMint.toString() === SOLANA_ADDRESS;

            return {
                mint: targetTokenAddress,
                user: user,
                isBuy: isBuy,
                solAmount: totalSolAmount,
                tokenAmount: totalTokenAmount
            };
        }
    }

    handleMultipleEvents(events: {
        name: string,
        data: any
    }[], targetTokenAddress: string, decimals: number, user: string) {
        let solAmount = 0;
        let tokenAmount = 0;
        let lastSolMintEvent = null;
        let lastTokenMintEvent = null;

        for (let i = 0; i < events.length; i++) {
            const event = events[i];

            if (event.data.inputMint?.toString() === SOLANA_ADDRESS || event.data.outputMint?.toString() === SOLANA_ADDRESS) {
                solAmount += event.data.inputMint?.toString() === SOLANA_ADDRESS
                    ? handle_decimals(event.data.inputAmount, 9)
                    : handle_decimals(event.data.outputAmount, 9);

                lastSolMintEvent = event;
            }

            if (event.data.inputMint?.toString() === targetTokenAddress || event.data.outputMint?.toString() === targetTokenAddress) {
                tokenAmount += event.data.inputMint?.toString() === targetTokenAddress
                    ? handle_decimals(event.data.inputAmount, decimals)
                    : handle_decimals(event.data.outputAmount, decimals);

                lastTokenMintEvent = event;
            }
        }
        const isBuy = lastSolMintEvent && lastSolMintEvent.data.inputMint?.toString() === SOLANA_ADDRESS;

        return {
            mint: targetTokenAddress,
            user: user,
            isBuy: isBuy,
            solAmount: solAmount,
            tokenAmount: tokenAmount
        }
    }

    async composeJupiterTransaction(
        isBuy: boolean,
        mintAddress: string,
        amount: number,
        slippage: number,
        priorityFee: number,
        jitoFeeInSol: number,
        side: "in" | "out"
    ): Promise<Transaction> {
        const quoteResponse = isBuy ?
            await this.getRouteForSwap(SOLANA_ADDRESS, mintAddress, amount, slippage) :
            await this.getRouteForSwap(mintAddress, SOLANA_ADDRESS, amount, slippage)

        return await this.getTransaction(quoteResponse, priorityFee, slippage, jitoFeeInSol);
    }

    async getRouteForSwap(baseAddress: string, quoteAddress: string, amount: number, slippage: number) {
        const quoteResponse = await (
            await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=${baseAddress}&outputMint=${quoteAddress}&amount=${amount}&slippageBps=${slippage}&asLegacyTransaction=true`
            )
        ).json();

        return quoteResponse
    }

    async getTransaction(quoteResponse: any, priorityFee: number, slippage: number, jitoFeeInSol: number)  {
        const { swapTransaction } = await (
            await fetch('https://quote-api.jup.ag/v6/swap', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                quoteResponse,
                userPublicKey: this.wallet.publicKey.toString(),
                wrapAndUnwrapSol: true,
                dynamicComputeUnitLimit: true,
                prioritizationFeeLamports: priorityFee * LAMPORTS_PER_SOL,
                dynamicSlippage: { "maxBps": slippage },
                asLegacyTransaction: true
                // feeAccount is optional. Use if you want to charge a fee.  feeBps must have been passed in /quote API.
                // feeAccount: "fee_account_public_key"
                })
            })
        ).json();

        // deserialize the transaction
        const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
        // let transaction = VersionedTransaction.deserialize(swapTransactionBuf); //If versionedTransaction
        // transaction.sign([this.wallet.payer]); //If versionedTransaction
        let transaction = Transaction.from(swapTransactionBuf)

        //Add Jito Fee:
        const jito_validator_wallet = await getRandomValidator();
        const fee = jitoFeeInSol * LAMPORTS_PER_SOL;
        const jitoFeeInstruction = SystemProgram.transfer({
            fromPubkey: this.wallet.publicKey,
            toPubkey: jito_validator_wallet,
            lamports: fee,
        });
        transaction.add(jitoFeeInstruction);

        // sign the transaction
        transaction.sign(this.wallet.payer);
        return transaction
    }

    //This function is for Versioned Transaction, it can be used when we don't want to use Jito with Jupiter.
    async sendTransaction(transaction: VersionedTransaction) {
        const latestBlockHash = await this.connection.getLatestBlockhash();
        const timeout = 3 * 60 * 1000
        let done = false;
        const rawTransaction = transaction.serialize()

        const txId = await this.connection.sendRawTransaction(rawTransaction, {
            skipPreflight: true,
            maxRetries: 5
        });
        const startTime = getUnixTime();
        (async () => {
            while(!done && getUnixTime() - startTime < timeout) {
                await this.connection.sendRawTransaction(rawTransaction, {
                    skipPreflight: true,
                    maxRetries: 5
                });
                await sleep(50);
            }
        })();
        try {
            const confirmation = await awaitTransactionSignatureConfirmation(
                txId,
                timeout,
                this.connection,
                "confirmed",
                true
            );

            if (!confirmation)
                throw new Error("Timed out awaiting confirmation on transaction");

            if (confirmation.err) {
                const tx = await this.connection.getTransaction(txId);
                logger.error(tx?.meta?.logMessages?.join("\n"))
                logger.error(confirmation.err.toString())
                throw new Error("Transaction failed: Custom instruction error");
            }

        } catch (err: any) {
            logger.error(`Timeout error caught ${JSON.stringify(err)}`)
            if (err.timeout) {
                throw new Error("Timed out awaiting confirmation on transaction");
            }

            if (err.err) {
                // await sleep(1000)
                throw err;
            }

            throw err;
        } finally {
            done = true;
        }

        logger.info(`Execution time ${txId} ${getUnixTime() - startTime}`)

        return txId;

        // await this.connection.confirmTransaction({
        //     blockhash: latestBlockHash.blockhash,
        //      lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
        //      signature: txId
        // })
        // logger.info(`https://solscan.io/tx/${txId}`)
    }

}
export default JupiterSwap
