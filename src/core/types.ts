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
  vesting_type?: string | null;
  chain_id?: string;
  /** CoinGecko API coin id (e.g. arbitrum, ethereum). */
  coingecko_id?: string | null;
  /** CoinPaprika API ticker id (e.g. arb-arbitrum, eth-ethereum). */
  paprika_id?: string | null;
}

export interface VestingAnalysisRow {
  token_symbol: string;
  contract_address: string;
  vesting_type: string | null;
  expected_vested: number;
  claimed_amount: number;
  remaining_locked: number;
  next_unlock_estimate: number | null;
  last_updated: Date;
  vesting_rate_per_second: number | null;
  accelerated_claim: boolean;
  unlock_density: number | null;
  vesting_confidence: number;
  chain_id?: string;
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

export type ExchangeClusterType = "cex" | "hot_wallet" | "deposit_router";

export interface ExchangeCluster {
  clusterTag: string;
  label: string;
  addresses: string[];
  clusterType: ExchangeClusterType;
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
  high_velocity: boolean;
  suspected_hot_wallet: boolean;
  cluster_tag: string | null;
  velocity_score: number;
  cluster_concentration_ratio: number | null;
  routed_to_exchange: boolean;
  chain_id?: string;
}

export interface MarketSnapshot {
  token_symbol: string;
  price_usd: number;
  circulating_supply: number;
  avg_30d_volume_usd: number;
  market_cap_usd: number;
  liquidity_depth_usd: number;
  fetched_at: string;
}

/** Liquidity stress from unlock pressure vs market liquidity model. */
export type LiquidityRiskLevel = "LOW" | "MODERATE" | "HIGH" | "EXTREME";

export interface LiquidityStressResult {
  unlockAmount: number;
  unlockValueUSD: number;
  volume30dAvg: number;
  unlockToVolumeRatio: number;
  circulatingSupply: number;
  unlockToSupplyPct: number;
  fdv?: number;
  unlockToFDVPct?: number;
  compositeScore: number;
  riskLevel: LiquidityRiskLevel;
  insufficientData?: boolean;
}

export type RiskLevel = "low" | "moderate" | "high" | "extreme";

export interface ChainReport {
  next_unlock_date: string;
  unlock_amount: number;
  unlock_percent_supply: number;
  risk_level: RiskLevel;
  score_numeric: number;
  sellable_supply: {
    scheduled_amount: number;
    claimed_amount: number;
    retained_amount: number;
    exchange_inflow: number;
    real_sellable_supply: number;
  };
}

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
  primary_driver: string;
  sell_pressure_estimate: string;
  sellable_supply: {
    scheduled_amount: number;
    claimed_amount: number;
    retained_amount: number;
    exchange_inflow: number;
    real_sellable_supply: number;
  };
  fetched_at: string;
  /** Unlock pressure vs liquidity metrics (composite score, risk level, ratios). */
  liquidityStress?: LiquidityStressResult;
  /** Multi-chain: per-chain reports when available */
  chains?: Record<string, ChainReport>;
  /** Multi-chain: aggregated score across chains (optional weighting) */
  combined_score?: number;
}

export type RawChainLog = {
  blockNumber: number;
  transactionHash: string;
  topics: string[];
  data: string;
  /** Log index within the block (for deduplication and deterministic ordering). */
  logIndex?: number;
};

export type RawChainBlock = {
  number: number;
  timestamp: number;
};

export interface TokenTransfer {
  from: string;
  to: string;
  value: string;
  blockNumber: number;
  txHash: string;
}

export interface ChainProvider {
  getLogs(
    contractAddress: string,
    fromBlock: number,
    toBlock: number
  ): Promise<RawChainLog[]>;
  getBlock(blockNumber: number): Promise<RawChainBlock | null>;
  /** Optional: latest block number (for chain freshness metadata). */
  getLatestBlockNumber?(): Promise<number>;
  getTokenTransfers?(
    tokenAddress: string,
    fromBlock: number,
    toBlock: number
  ): Promise<TokenTransfer[]>;
  /** Optional: eth_call for vesting contract detection (to, data hex). Returns hex result or "0x" on failure. */
  call?(to: string, data: string): Promise<string>;
}

export interface MarketDataProvider {
  getMarketSnapshot(tokenSymbol: string): Promise<MarketSnapshot>;
}

export interface ExchangeInfo {
  isExchange: boolean;
  exchangeLabel?: string;
  clusterTag?: string;
}

export interface ExchangeRegistry {
  isKnownExchangeAddress(address: string): boolean;
  isExchangeAddress(address: string): boolean;
  getExchangeLabel(address: string): string | null;
  getExchangeInfo(address: string, chainId?: string): ExchangeInfo;
  /** Cluster-level: get cluster by tag (address → clusterTag, clusterTag → cluster). */
  getCluster?(clusterTag: string): ExchangeCluster | null;
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
