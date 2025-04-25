import logger from '../logging/LoggerManager'
import {jitoValidators} from "../../constants/constants";
import {Commitment, Connection, PublicKey, SignatureStatus, TransactionSignature} from "@solana/web3.js";
require('dotenv').config();

const connection = new Connection(process.env.RPC_URL, {commitment: 'confirmed'});

export async function getTokenDecimals(address: string) {
    try {
        const info = await connection.getTokenSupply(new PublicKey(address))
        return info.value.decimals
    } catch (e) {
        throw new Error(`Error getting token decimals: ${e}`)
    }
}

export function getUnixTime(): number {
    return new Date().valueOf() / 1000;
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function retryOperation<T>(operation: () => Promise<T>, maxAttempts: number, delay: number): Promise<T> {
    let attempts = 1;
    while (true) {
        try {
            return await operation();
        } catch (error: any) {
            logger.error(`Attempt ${attempts} failed: ${error.message}`)
            attempts++;
            if (attempts >= maxAttempts || !shouldRetry(error)) {
                throw error;
            }
            await sleep(delay);
        }
    }
}

export function shouldRetry(error: any): boolean {
    // Maybe Retry logic
    return true;
}

export function handle_decimals(number: string, decimals: number) {
    return parseFloat(number) / 10 ** decimals
}

export function number_to_decimals(number: number, decimals: number) {
    return number * 10 ** decimals
}

export function formatPortfolioTable(portfolio: { [key: string]: { asset: string, amount: number } }, padding: number = 0): string {
  const assets = Object.keys(portfolio);

  const maxTokenLength = Math.max(...assets.map(asset => `${asset.substring(0, 5)}...${asset.substring(asset.length - 4)}`.length));
  const maxAmountLength = Math.max(...assets.map(asset => portfolio[asset].amount.toFixed(2).length));

  let table = ' '.repeat(padding) + 'Token' + ' '.repeat(maxTokenLength - 5) + ' | Amount\n';
  table += ' '.repeat(padding) + ' '.padEnd(maxTokenLength + 2, '-') + '|'.padEnd(maxAmountLength + 3, '-') + '\n';

  assets.forEach(asset => {
    const shortAsset = `${asset.substring(0, 5)}...${asset.substring(asset.length - 4)}`;
    const amount = portfolio[asset].amount.toFixed(2);

    table += ' '.repeat(padding) + `${shortAsset.padEnd(maxTokenLength)} | ${amount.padStart(maxAmountLength)}\n`;
  });

  return table;
}

export async function getRandomValidator() {
    const res = jitoValidators[Math.floor(Math.random() * jitoValidators.length)];
    return new PublicKey(res);
}

export const awaitTransactionSignatureConfirmation = async (
    txid: TransactionSignature,
    timeout: number,
    connection: Connection,
    commitment: Commitment = "recent",
    queryStatus = false
): Promise<SignatureStatus | null | void> => {
    let done = false;
    let status: SignatureStatus | null | void = {
        slot: 0,
        confirmations: 0,
        err: null,
    };
    let subId = 0;
    status = await new Promise(async (resolve, reject) => {
        setTimeout(() => {
            if (done) {
                return;
            }
            done = true;
            logger.warn('Rejecting for timeout...')
            reject({timeout: true});
        }, timeout);
        try {
            logger.info(`COMMITMENT ${commitment}`)
            subId = connection.onSignature(
                txid,
                (result: any, context: any) => {
                    done = true;
                    status = {
                        err: result.err,
                        slot: context.slot,
                        confirmations: 0,
                    };
                    if (result.err) {
                        logger.error(`Rejected via websocket ${JSON.stringify(result.err)}`)
                        reject(status);
                    } else {
                        logger.info(`Resolved via websocket ${JSON.stringify(result)}`)
                        resolve(status);
                    }
                },
                commitment
            );
        } catch (e) {
            done = true;
            logger.error(`WS error in setup ${txid} ${e}`)
        }
        while (!done && queryStatus) {
            // eslint-disable-next-line no-loop-func
            (async () => {
                try {
                    const signatureStatuses = await connection.getSignatureStatuses([
                        txid,
                    ], {searchTransactionHistory: true,});
                    status = signatureStatuses && signatureStatuses.value[0];
                    if (!done) {
                        if (!status) {
                            //logger.warn(`REST null result for ${txid} ${status}`)
                        } else if (status.err) {
                            logger.error(`REST error for ${txid} ${JSON.stringify(status)}`)
                            done = true;
                            reject(status.err);
                        } else if (!status.confirmations && !status.confirmationStatus) {
                            logger.warn(`REST no confirmations for ${txid} ${status.confirmationStatus}`)
                        } else {
                            // logger.info(`REST confirmation for ${txid} ${status.confirmationStatus}`)
                            if (
                                !status.confirmationStatus || status.confirmationStatus ==
                                commitment
                            ) {
                                done = true;
                                resolve(status);
                            }
                        }
                    }
                } catch (e) {
                    if (!done) {
                        logger.error(`REST connection error: txid ${txid} ${e}`)
                    }
                }
            })();
            await sleep(2000);
        }
    });

    //@ts-ignore
    if (connection._signatureSubscriptions && connection._signatureSubscriptions[subId]) {
        connection.removeSignatureListener(subId);
    }
    done = true;
    return status;
};
