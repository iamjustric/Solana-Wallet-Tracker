import base58 from 'bs58'
import {BorshCoder} from "@coral-xyz/anchor";
import {IDLPumpFun} from "../../services/IDL";
import {base64} from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import BN from "bn.js";
import {
    Keypair,
    PublicKey,
    SystemProgram,
    TransactionInstruction,
    Connection,
    ComputeBudgetProgram,
    Transaction, LAMPORTS_PER_SOL
} from "@solana/web3.js";
import {
    AccountMeta,
    AccountMetaReadonly,
    RENT_PROGRAM_ID,
    SPL_ACCOUNT_LAYOUT,
    struct,
    TOKEN_PROGRAM_ID,
    u64,
    WSOL
} from "@raydium-io/raydium-sdk"
import {
    createAssociatedTokenAccountInstruction,
    createCloseAccountInstruction,
    createInitializeAccountInstruction,
    getAssociatedTokenAddress
} from "@solana/spl-token";
import {ASSOCIATED_PROGRAM_ID} from "@project-serum/anchor/dist/cjs/utils/token";
import {
    FEE_RECIPIENT,
    GLOBAL,
    jitoValidators, PUMP_FUN_ACCOUNT, PUMP_FUN_PROGRAM,
    PUMP_FUN_PROGRAM_ID,
    RENT,
    TOKEN_PROGRAM_ID1
} from "../../constants/constants";
import {Wallet} from "@project-serum/anchor";
import {getRandomValidator} from "../../common/utils";
import {ProjectInfo, TradeEvent} from "../../common/interfaces/interfaces";


class PumpFunSwap {
    connection: Connection
    wallet: Wallet

    constructor(RPC_URL: string, WALLET_PRIVATE_KEY: string) {
        this.connection = new Connection(RPC_URL, {commitment: 'confirmed'})
        this.wallet = new Wallet(Keypair.fromSecretKey(base58.decode(WALLET_PRIVATE_KEY)))
    }

    async calculateAmountOut(info: ProjectInfo, amountIn: number, slippage: number, side: "in" | "out") {
        let _amountIn = new BN(amountIn)
        let baseAmount = new BN(info.virtual_sol_reserves)
        let quoteAmount = new BN(info.virtual_token_reserves)
        if (side != "in") {
            [baseAmount, quoteAmount] = [quoteAmount, baseAmount]
        }

        let denominator = baseAmount.add(_amountIn)
        let amountOut = quoteAmount.mul(_amountIn).div(denominator)
        let minimumAmountOut = amountOut.mul(new BN(100 - slippage)).div(new BN(100))
        return {amountIn: _amountIn, amountOut, minimumAmountOut}
    }

    async makeSwapInstructionsAuto(
        info: ProjectInfo,
        amount: number,
        slippage: number,
        side: "in" | "out"
    ) {
        let {amountIn, minimumAmountOut} = await this.calculateAmountOut(info, amount, slippage, side)

        let data: Buffer;
        if (side == "in") {
            const layout = struct(
                [
                    u64("instruction"),
                    u64("amount"),
                    u64("maxSolCost")
                ]
            );
            data = Buffer.alloc(layout.span)
            layout.encode({
                instruction: new BN("16927863322537952870"),
                amount: minimumAmountOut,
                maxSolCost: amountIn
            }, data)
        } else {
            const layout = struct(
                [
                    u64("instruction"),
                    u64("amount"),
                    u64("minSolOutput")
                ]
            );
            data = Buffer.alloc(layout.span)
            layout.encode({
                instruction: new BN("12502976635542562355"),
                amount: amountIn,
                minSolOutput: new BN(0)
            }, data) //Cambiato qua da minimumAmountOut a amountIn.
        }

        const instructions: TransactionInstruction[] = []

        const [accountIn, accountInToken] = await this.getTokenAccounts(
            amountIn,
            this.wallet.payer,
            side == "in" ? new PublicKey(WSOL.mint) : new PublicKey(info.mint),
            "in",
            instructions
        );
        const [accountOut, _] = await this.getTokenAccounts(
            amountIn,
            this.wallet.payer,
            side == "out" ? new PublicKey(WSOL.mint) : new PublicKey(info.mint),
            "out",
            instructions
        );

        const keys = [
            AccountMetaReadonly(new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf"), false),
            AccountMeta(new PublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM"), false),
            AccountMetaReadonly(new PublicKey(info.mint), false),
            AccountMeta(new PublicKey(info.bonding_curve), false),
            AccountMeta(new PublicKey(info.associated_bonding_curve), false),
            AccountMeta(new PublicKey(side == "in" ? accountOut : accountIn), false),
            AccountMeta(this.wallet.publicKey, true),
            AccountMetaReadonly(SystemProgram.programId, false),
            AccountMetaReadonly(side == "in" ? TOKEN_PROGRAM_ID : ASSOCIATED_PROGRAM_ID, false),
            AccountMetaReadonly(side == "in" ? RENT_PROGRAM_ID : TOKEN_PROGRAM_ID, false),
            AccountMetaReadonly(new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1"), false),
            AccountMetaReadonly(new PublicKey(PUMP_FUN_PROGRAM_ID), false)
        ]

        instructions.push(new TransactionInstruction({
            programId: new PublicKey(PUMP_FUN_PROGRAM_ID),
            keys,
            data
        }))

        instructions.push(createCloseAccountInstruction(
            accountInToken.toBase58() == WSOL.mint ? accountIn : accountOut,
            this.wallet.publicKey,
            this.wallet.publicKey,
        ))

        return instructions
    }

    async getTokenAccounts(
        amountIn: BN,
        signer: Keypair,
        token: PublicKey,
        side: "in" | "out",
        instructions: TransactionInstruction[],
        multiCount: number = 1
    ): Promise<[PublicKey, PublicKey]> {
        const tokenAccount = await this.connection.getParsedTokenAccountsByOwner(
            signer.publicKey,
            {mint: token}
        );

        if (tokenAccount.value.length > 0) {
            return [tokenAccount.value[0].pubkey, token]
        }

        const ataAddress = await getAssociatedTokenAddress(token, signer.publicKey)

        let accountLamports = await this.connection.getMinimumBalanceForRentExemption(SPL_ACCOUNT_LAYOUT.span)
        if (token.toBase58() == WSOL.mint) {
            if (side == "in") {
                accountLamports += amountIn.toNumber()
                accountLamports *= multiCount
            }

            const seed = Keypair.generate().publicKey.toBase58().slice(0, 32)
            const pubKey = await PublicKey.createWithSeed(signer.publicKey, seed, TOKEN_PROGRAM_ID)

            const createInst = SystemProgram.createAccountWithSeed({
                fromPubkey: signer.publicKey,
                basePubkey: signer.publicKey,
                seed: seed,
                newAccountPubkey: pubKey,
                lamports: accountLamports,
                space: SPL_ACCOUNT_LAYOUT.span,
                programId: TOKEN_PROGRAM_ID
            })
            instructions?.push(createInst)
            instructions?.push(
                createInitializeAccountInstruction(
                    pubKey,
                    token,
                    signer.publicKey,
                    TOKEN_PROGRAM_ID
                )
            )
            return [pubKey, token]
        }

        instructions?.push(
            createAssociatedTokenAccountInstruction(
                signer.publicKey,
                ataAddress,
                signer.publicKey,
                token,
                TOKEN_PROGRAM_ID
            )
        )
        return [ataAddress, token]
    }

    async createTransaction(
        instructions: TransactionInstruction[],
        priorityFeeInSol: number,
        jitoFeeInSol: number
    ) {
        const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({units: 1400000});
        const transaction = new Transaction().add(modifyComputeUnits);

        if (priorityFeeInSol > 0) {
            const microLamports = priorityFeeInSol * LAMPORTS_PER_SOL;
            const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({microLamports});
            transaction.add(addPriorityFee);
        }
        transaction.add(...instructions);
        transaction.feePayer = this.wallet.publicKey;

        // Adding Jito fee transfer instruction
        const jito_validator_wallet = await getRandomValidator();
        const fee = jitoFeeInSol * LAMPORTS_PER_SOL;
        const jitoFeeInstruction = SystemProgram.transfer({
            fromPubkey: this.wallet.publicKey,
            toPubkey: jito_validator_wallet,
            lamports: fee,
        });
        transaction.add(jitoFeeInstruction);

        const recentBlockhash = await this.connection.getLatestBlockhash();
        transaction.recentBlockhash = recentBlockhash.blockhash;

        transaction.sign(this.wallet.payer)
        return transaction;
    }

    async getPumpFunTransaction(
        info: ProjectInfo,
        amount: number,
        slippage: number,
        side: "in" | "out",
        priorityFeeInSol: number,
        jitoFeeInSol: number
    ): Promise<Transaction> {
        const instructions = await this.makeSwapInstructionsAuto(info, amount, slippage, side)

        return await this.createTransaction(instructions, priorityFeeInSol, jitoFeeInSol);
    }

    async getProjectInfo(mintAddress: string): Promise<ProjectInfo | null> {
        try {
            let response = await fetch(`https://frontend-api-v3.pump.fun/coins/${mintAddress}`, {
                headers: {
                    'Accept': '*/*',
                    'Accept-Language': 'tr-TR,tr;q=0.9,en-TR;q=0.8,en;q=0.7,en-US;q=0.6',
                    'Connection': 'keep-alive',
                    'If-None-Match': 'W/"49d-FNgs3sHMrdKLmLz1c9o3umsQQrk"',
                    'Origin': 'https://pump.fun',
                    'Referer': 'https://pump.fun/',
                    'Sec-Fetch-Dest': 'empty',
                    'Sec-Fetch-Mode': 'cors',
                    'Sec-Fetch-Site': 'cross-site',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
                    'sec-ch-ua-mobile': '?0',
                    'sec-ch-ua-platform': '"Windows"'
                }
            });
            let jsonResp = await response.json()
            if (jsonResp["statusCode"]) return null
            return jsonResp as ProjectInfo

        } catch (e) {
            throw new Error('Error getting PumpFun project info: ' + e.message);
        }

    }

    getDataToDecode(txnInfo: any, user: string) {
        let tradeEvent: TradeEvent | null = null;
        const dataList: string[] = []
        const decodedList = []
        const innerInstructions = txnInfo.transaction?.meta?.innerInstructions || txnInfo.meta?.innerInstructions;
        if (!innerInstructions) return null
        for (const innerInstruction of innerInstructions) {
            for (const instruction of innerInstruction.instructions) {
                const data = instruction?.data
                if (data) {
                    dataList.push(data)
                }
            }
        }
        if (!dataList) return null
        for (const data of dataList) {
            const args = this.decodePumpFunTransaction(data)
            if (args) {
                decodedList.push(this.formatTradeEventOutput(args))
            }
        }
        return decodedList.filter(decoded => decoded.user === user)[0]
    }

    decodePumpFunTransaction(base58Data: string) {
        let buffer = Buffer.from(base58.decode(base58Data));
        buffer = buffer.slice(8);
        let coder = new BorshCoder(IDLPumpFun as any);
        let args = coder.events.decode(base64.encode(buffer));
        return args
    }

    formatTradeEventOutput(decodedTxn: { name: string, data: any }): TradeEvent {
        return {
            mint: decodedTxn.data.mint.toString(),
            user: decodedTxn.data.user.toString(),
            isBuy: decodedTxn.data.isBuy,
            solAmount: Number(decodedTxn.data.solAmount.toString()) / 10 ** 9,
            tokenAmount: Number(decodedTxn.data.tokenAmount.toString()) / 10 ** 6
        }
    }

}

export default PumpFunSwap
