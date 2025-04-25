import {
    Connection,
    PublicKey,
    Keypair,
    Transaction,
    VersionedTransaction,
    TransactionMessage,
    ParsedTransactionWithMeta,
    ParsedInstruction,
    LAMPORTS_PER_SOL,
    SystemProgram, TokenBalance
} from '@solana/web3.js'
import {
    Liquidity,
    LiquidityPoolKeys,
    jsonInfo2PoolKeys,
    LiquidityPoolJsonInfo,
    TokenAccount,
    Token,
    TokenAmount,
    TOKEN_PROGRAM_ID,
    Percent,
    SPL_ACCOUNT_LAYOUT,
    LIQUIDITY_STATE_LAYOUT_V4,
    MARKET_STATE_LAYOUT_V3,
    Market,
} from '@raydium-io/raydium-sdk'
import {Wallet, AnchorProvider} from '@project-serum/anchor'
import base58 from 'bs58'
import logger from '../../common/logging/LoggerManager'
import {RAYDIUM_V4_AUTHORITY, SOLANA_ADDRESS} from "../../constants/constants";
import {TradeEvent} from "../../common/interfaces/interfaces";
import {sleep, getRandomValidator} from "../../common/utils";

class RaydiumSwap {
    static RAYDIUM_V4_PROGRAM_ID = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'

    // @ts-ignore
    allPoolKeysJson: LiquidityPoolJsonInfo[]
    connection: Connection
    wallet: Wallet
    provider: AnchorProvider

    constructor(RPC_URL: string, WALLET_PRIVATE_KEY: string) {
        this.connection = new Connection(RPC_URL, {commitment: 'confirmed'})
        this.wallet = new Wallet(Keypair.fromSecretKey(base58.decode(WALLET_PRIVATE_KEY)))
        this.provider = new AnchorProvider(this.connection, this.wallet, {commitment: 'confirmed'})
    }

    async getProgramAccounts(baseMint: string, quoteMint: string) {
        const layout = LIQUIDITY_STATE_LAYOUT_V4

        return this.connection.getProgramAccounts(new PublicKey(RaydiumSwap.RAYDIUM_V4_PROGRAM_ID), {
            filters: [
                {dataSize: layout.span},
                {
                    memcmp: {
                        offset: layout.offsetOf('baseMint'),
                        bytes: new PublicKey(baseMint).toBase58(),
                    },
                },
                {
                    memcmp: {
                        offset: layout.offsetOf('quoteMint'),
                        bytes: new PublicKey(quoteMint).toBase58(),
                    },
                },
            ],
        })
    }

    async findRelevantPoolInfo(baseMint: string): Promise<LiquidityPoolKeys | null | undefined> {
        let poolInfo = await this.findRaydiumPoolInfo(baseMint, SOLANA_ADDRESS)
        if (!poolInfo) poolInfo = await this.findRaydiumPoolInfo(SOLANA_ADDRESS, baseMint)
        return poolInfo
    }

    async findRaydiumPoolInfo(
        baseMint: string,
        quoteMint: string
    ): Promise<LiquidityPoolKeys | undefined | null> {
        const layout = LIQUIDITY_STATE_LAYOUT_V4

        const programData = await this.getProgramAccounts(baseMint, quoteMint)

        const collectedPoolResults = programData
            .map((info) => ({
                id: new PublicKey(info.pubkey),
                version: 4,
                programId: new PublicKey(RaydiumSwap.RAYDIUM_V4_PROGRAM_ID),
                ...layout.decode(info.account.data),
            }))
            .flat()

        const pool = collectedPoolResults[0]


        if (!pool) return null

        const market = await this.connection.getAccountInfo(pool.marketId).then((item) => ({
            programId: item!.owner,
            ...MARKET_STATE_LAYOUT_V3.decode(item!.data),
        }))

        const authority = Liquidity.getAssociatedAuthority({
            programId: new PublicKey(RaydiumSwap.RAYDIUM_V4_PROGRAM_ID),
        }).publicKey

        const marketProgramId = market.programId

        const poolKeys = {
            status: pool.status,
            swapBaseIn: pool.swapBaseInAmount,
            swapQuoteOut: pool.swapQuoteOutAmount,
            swapBaseOut: pool.swapBaseInAmount,
            swapQuoteIn: pool.swapQuoteOutAmount,
            id: pool.id,
            baseMint: pool.baseMint,
            quoteMint: pool.quoteMint,
            lpMint: pool.lpMint,
            baseDecimals: Number.parseInt(pool.baseDecimal.toString()),
            quoteDecimals: Number.parseInt(pool.quoteDecimal.toString()),
            lpDecimals: Number.parseInt(pool.baseDecimal.toString()),
            version: pool.version,
            programId: pool.programId,
            openOrders: pool.openOrders,
            targetOrders: pool.targetOrders,
            baseVault: pool.baseVault,
            quoteVault: pool.quoteVault,
            marketVersion: 3,
            authority: authority,
            marketProgramId,
            marketId: market.ownAddress,
            marketAuthority: Market.getAssociatedAuthority({
                programId: marketProgramId,
                marketId: market.ownAddress,
            }).publicKey,
            marketBaseVault: market.baseVault,
            marketQuoteVault: market.quoteVault,
            marketBids: market.bids,
            marketAsks: market.asks,
            marketEventQueue: market.eventQueue,
            withdrawQueue: pool.withdrawQueue,
            lpVault: pool.lpVault,
            lookupTableAccount: PublicKey.default,
        } as LiquidityPoolKeys

        return poolKeys
    }

    async getOwnerTokenAccounts() {
        const walletTokenAccount = await this.connection.getTokenAccountsByOwner(this.wallet.publicKey, {
            programId: TOKEN_PROGRAM_ID,
        })

        return walletTokenAccount.value.map((i) => ({
            pubkey: i.pubkey,
            programId: i.account.owner,
            accountInfo: SPL_ACCOUNT_LAYOUT.decode(i.account.data),
        }))
    }

    getMintAddress(
        txInfo: any,
        user: string
    ): string {
        let mintAddress: string = '';
        const preTokenBalances: TokenBalance[] = txInfo.transaction.meta?.preTokenBalances as Array<TokenBalance>
        const preBalance: TokenBalance = preTokenBalances?.find(
            (balance) => balance.mint !== SOLANA_ADDRESS && balance.owner === user) as TokenBalance

        if (preBalance && preBalance.mint) {
            mintAddress = preBalance.mint;
        } else {
            for (const innerInstruction of txInfo.transaction.meta.innerInstructions) {
                for (const instruction of innerInstruction.instructions) {
                    if (instruction?.parsed?.type === 'initializeAccount3') {
                        mintAddress = instruction?.parsed?.info.mint
                    }
                }
            }
        }

        return mintAddress
    }

    _getTargetMintAddress( //Maybe
        preTokenBalances: TokenBalance[],
        postTokenBalances: TokenBalance[],
        user: string
    ): string[] { //Da provare questo al posto di getMintAddress.
        const preTokens = preTokenBalances.filter(
            (balance) => balance.owner === user && balance.mint !== SOLANA_ADDRESS
        );

        const postTokens = postTokenBalances.filter(
            (balance) => balance.owner === user && balance.mint !== SOLANA_ADDRESS
        );

        const tokenList: TokenBalance[] = [...preTokens, ...postTokens];
        const mints: string[] = tokenList.map(token => token.mint);

        return Array.from(new Set(mints));
    }

    checkIfSellOrBuy(txInfo: any) {
        const postTokenBalances = txInfo.transaction.meta?.postTokenBalances as Array<TokenBalance>;
        const preTokenBalances = txInfo.transaction.meta?.preTokenBalances as Array<TokenBalance>;

        const postBalance = postTokenBalances.find(
            (balance) => balance.mint === SOLANA_ADDRESS && balance.owner === RAYDIUM_V4_AUTHORITY
        );
        const preBalance = preTokenBalances.find(
            (balance) => balance.mint === SOLANA_ADDRESS && balance.owner === RAYDIUM_V4_AUTHORITY
        );

        if (postBalance && preBalance) {
            const postAmount = Number(postBalance.uiTokenAmount.amount);
            const preAmount = Number(preBalance.uiTokenAmount.amount);

            if (postAmount > preAmount) {
                return "buy";
            } else if (postAmount < preAmount) {
                return "sell";
            }
        }

        return "unknown";
    }

    findSwapAmounts(
        txInfo: any,
        type: string,
        deployer: string,
        decimals: number
    ): [number | undefined, number | undefined] {
        let solAmount: number | undefined;
        let tokenAmount: number | undefined;

        const innerInstructions =
            txInfo.transaction?.meta?.innerInstructions ??
            txInfo.meta?.innerInstructions ??
            [];

        for (const innerInstruction of innerInstructions) {
            for (const instruction of innerInstruction.instructions) {
                if (
                    !instruction.parsed ||
                    instruction.parsed.type !== 'transfer' ||
                    !instruction.parsed.info
                ) {
                    continue;
                }

                const {authority, amount} = instruction.parsed.info;
                const isDeployer = authority === deployer;

                if (type === 'buy') {
                    if (isDeployer) {
                        solAmount = amount / 10 ** 9;
                    } else {
                        tokenAmount = amount / 10 ** decimals;
                    }
                } else {
                    if (isDeployer) {
                        tokenAmount = amount / 10 ** decimals;
                    } else {
                        solAmount = amount / 10 ** 9;
                    }
                }

                if (solAmount != null && tokenAmount != null) {
                    return [solAmount, tokenAmount];
                }
            }
        }

        return [solAmount, tokenAmount];
    }

    formatRaydiumTradeEvent(
        mint: string,
        user: string,
        type: string,
        amounts: number[]
    ): TradeEvent {
        return {
            mint: mint,
            user: user,
            isBuy: type === 'buy',
            solAmount: amounts[0],
            tokenAmount: amounts[1]
        }
    }

    async getSwapTransaction(
        toToken: string,
        amount: number,
        poolKeys: LiquidityPoolKeys,
        maxLamports: number = 100000,
        useVersionedTransaction = true,
        fixedSide: 'in' | 'out' = 'in',
        slippage: number,
        jitoFeeInSol: number
    ): Promise<Transaction | VersionedTransaction> {
        const directionIn = poolKeys.quoteMint.toString() == toToken
        const {minAmountOut, amountIn} = await this.calcAmountOut(
            poolKeys,
            amount,
            slippage,
            directionIn
        );

        const userTokenAccounts = await this.getOwnerTokenAccounts()
        const swapTransaction = await Liquidity.makeSwapInstructionSimple({
            connection: this.connection,
            makeTxVersion: useVersionedTransaction ? 0 : 1,
            poolKeys: {
                ...poolKeys,
            },
            userKeys: {
                tokenAccounts: userTokenAccounts,
                owner: this.wallet.publicKey,
            },
            amountIn: amountIn,
            amountOut: minAmountOut,
            fixedSide: fixedSide,
            config: {
                bypassAssociatedCheck: false,
            },
            computeBudgetConfig: {
                microLamports: maxLamports,
            },
        })

        const recentBlockhashForSwap = await this.connection.getLatestBlockhash()
        const instructions = swapTransaction.innerTransactions[0].instructions.filter(Boolean)

        try {
            if (useVersionedTransaction) {
                const versionedTransaction = new VersionedTransaction(
                    new TransactionMessage({
                        payerKey: this.wallet.publicKey,
                        recentBlockhash: recentBlockhashForSwap.blockhash,
                        instructions: instructions,
                    }).compileToV0Message()
                )

                versionedTransaction.sign([this.wallet.payer])

                return versionedTransaction
            }

            const legacyTransaction = new Transaction({
                blockhash: recentBlockhashForSwap.blockhash,
                lastValidBlockHeight: recentBlockhashForSwap.lastValidBlockHeight,
                feePayer: this.wallet.publicKey,
            })

            legacyTransaction.add(...instructions)

            // Adding Jito fee transfer instruction.
            const jito_validator_wallet = await getRandomValidator();
            const fee = jitoFeeInSol * LAMPORTS_PER_SOL;
            const jitoFeeInstruction = SystemProgram.transfer({
                fromPubkey: this.wallet.publicKey,
                toPubkey: jito_validator_wallet,
                lamports: fee,
            });
            legacyTransaction.add(jitoFeeInstruction);

            legacyTransaction.sign(this.wallet.payer)
            return legacyTransaction

        } catch (error: any) {
            logger.error(`Error making a swap: ${error.message}`)
            await sleep(1000)
            throw new Error('Error making a swap...')
        }
    }

    async calcAmountOut(
        poolKeys: LiquidityPoolKeys,
        rawAmountIn: number,
        slippage: number = 5,
        swapInDirection: boolean
    ) {
        const poolInfo = await Liquidity.fetchInfo({connection: this.connection, poolKeys})

        let currencyInMint = poolKeys.baseMint
        let currencyInDecimals = poolInfo.baseDecimals
        let currencyOutMint = poolKeys.quoteMint
        let currencyOutDecimals = poolInfo.quoteDecimals

        if (!swapInDirection) {
            currencyInMint = poolKeys.quoteMint
            currencyInDecimals = poolInfo.quoteDecimals
            currencyOutMint = poolKeys.baseMint
            currencyOutDecimals = poolInfo.baseDecimals
        }

        const currencyIn = new Token(TOKEN_PROGRAM_ID, currencyInMint, currencyInDecimals)
        const amountIn = new TokenAmount(currencyIn, rawAmountIn, false)
        const currencyOut = new Token(TOKEN_PROGRAM_ID, currencyOutMint, currencyOutDecimals)
        const slippageX = new Percent(slippage, 100) // 5% slippage

        const {
            amountOut,
            minAmountOut,
            currentPrice,
            executionPrice,
            priceImpact,
            fee
        } = Liquidity.computeAmountOut({
            poolKeys,
            poolInfo,
            amountIn,
            currencyOut,
            slippage: slippageX,
        })

        return {
            amountIn,
            amountOut,
            minAmountOut,
            currentPrice,
            executionPrice,
            priceImpact,
            fee,
        }
    }
}

export default RaydiumSwap
