/**
 * Normalized domain types for the Intelligence Infrastructure.
 * All external data is normalized into these shapes.
 */

export interface TokenMetadata {
  token_symbol: string;
  contract_address: string;
  beneficiary_label: string;
  total_allocation: string;
  vesting_start: Date | null;
  vesting_cliff: Date | null;
  vesting_end: Date | null;
  release_frequency: string | null;
  last_verified_block: string | null;
}

export interface UnlockEvent {
  id: string;
  token_symbol: string;
  contract_address: string;
  event_type: string;
  amount: string;
  block_number: string;
  tx_hash: string | null;
  recipient_address: string | null;
  timestamp: Date | null;
}

export interface UnlockFlow {
  token_symbol: string;
  unlock_event_id: string;
  transferred_to_exchange: boolean;
  exchange_label: string | null;
  retained_in_wallet: boolean;
  moved_to_new_wallet: boolean;
  risk_flag: "none" | "moderate" | "high";
  exchange_inflow: number;
  retained_amount: number;
  analyzed_at: Date | null;
}

export interface MarketSnapshot {
  token_symbol: string;
  avg_30d_volume_usd: number;
  price_usd: number;
  market_cap_usd: number;
  liquidity_depth_usd: number;
  fetched_at: string;
}

export type RiskLevel = "low" | "moderate" | "high" | "extreme";

export interface IntelligenceReport {
  token_symbol: string;
  next_unlock_date: string;
  unlock_amount: number;
  unlock_percent_supply: number;
  unlock_vs_volume_ratio: number;
  cohort_type: string;
  historical_avg_7d_return: number;
  impact_score: string;
  risk_level: RiskLevel;
  risk_summary: string;
  score_numeric: number;
  explanation: string;
  sellable_supply: {
    scheduled_amount: number;
    claimed_amount: number;
    retained_amount: number;
    exchange_inflow: number;
    real_sellable_supply: number;
  };
  fetched_at: string;
}

export type RawChainLog = {
  blockNumber: number;
  transactionHash: string;
  topics: string[];
  data: string;
};

export type RawChainBlock = {
  number: number;
  timestamp: number;
};

export interface ChainProvider {
  getLogs(
    contractAddress: string,
    fromBlock: number,
    toBlock: number
  ): Promise<RawChainLog[]>;
  getBlock(blockNumber: number): Promise<RawChainBlock | null>;
}

export interface MarketDataProvider {
  getMarketSnapshot(tokenSymbol: string): Promise<MarketSnapshot>;
}

export interface ExchangeRegistry {
  isKnownExchangeAddress(address: string): boolean;
  getExchangeLabel(address: string): string | null;
}

export type UnlockEventType = "claim" | "transfer" | "vest";

export interface ParsedUnlockEvent {
  event_type: UnlockEventType;
  amount: string;
  block_number: number;
  tx_hash: string;
  timestamp: Date;
  recipient_address?: string | null;
}
