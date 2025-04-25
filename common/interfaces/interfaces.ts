export interface Transaction {
    type: string;
    asset: string;
    amount: string;
    price: string;
}

interface PortfolioEntry {
    asset: string;
    amount: number;
}

export interface Portfolio {
    [asset: string]: PortfolioEntry;
}

export interface ProjectInfo {
    mint: string;
    name: string;
    symbol: string;
    description: string;
    image_uri: string;
    metadata_uri: string;
    twitter: string;
    telegram: string;
    bonding_curve: string;
    associated_bonding_curve: string;
    creator: string;
    created_timestamp: number;
    raydium_pool: string | null;
    complete: boolean;
    virtual_sol_reserves: number;
    virtual_token_reserves: number;
    total_supply: number;
    website: string | null;
    show_name: boolean;
    king_of_the_hill_timestamp: number | null;
    market_cap: number;
    reply_count: number;
    last_reply: number;
    nsfw: boolean;
    market_id: string | null;
    inverted: boolean | null;
    username: string | null;
    profile_image: string | null;
    usd_market_cap: number;
}

export interface TradeEvent {
    mint: string,
    user: string,
    isBuy: boolean,
    solAmount: number,
    tokenAmount: number
}

export interface SwapHandler {
    programIds: Set<string>;
    canHandle(accountKeys: string[]): boolean;
    parseEvent(result: any, user: string): Promise<TradeEvent | null>;
    executeSwap(event: TradeEvent): Promise<void>;
}
