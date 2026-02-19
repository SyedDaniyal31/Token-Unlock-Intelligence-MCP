/**
 * Premium Unlock Ingestion — shared types for 3-layer pipeline.
 * Chain-agnostic; no blockchain SDK types.
 */

export type BeneficiaryLabel =
  | "team"
  | "vc"
  | "foundation"
  | "ecosystem";

export type ReleaseFrequency = "monthly" | "quarterly" | "linear";

export type UnlockEventType = "claim" | "transfer" | "vest";

export type FlowRiskFlag = "none" | "moderate" | "high";

export interface UnlockScheduleRow {
  id: string;
  token_symbol: string;
  contract_address: string;
  beneficiary_label: string;
  total_allocation: string;
  vesting_start: Date | null;
  vesting_cliff: Date | null;
  vesting_end: Date | null;
  release_frequency: string | null;
  last_verified_block: string | null;
  created_at: Date | null;
  updated_at: Date | null;
}

export interface UnlockEventRow {
  id: string;
  token_symbol: string;
  contract_address: string;
  event_type: string;
  amount: string;
  block_number: string;
  tx_hash: string | null;
  timestamp: Date | null;
  processed: boolean;
  created_at: Date | null;
}

export interface UnlockFlowAnalysisRow {
  id: string;
  token_symbol: string;
  unlock_event_id: string;
  transferred_to_exchange: boolean;
  exchange_label: string | null;
  retained_in_wallet: boolean;
  moved_to_new_wallet: boolean;
  risk_flag: string;
  analyzed_at: Date | null;
  created_at: Date | null;
}

export interface RegisterUnlockScheduleInput {
  token_symbol: string;
  contract_address: string;
  beneficiary_label: BeneficiaryLabel;
  total_allocation: number;
  vesting_start?: Date | null;
  vesting_cliff?: Date | null;
  vesting_end?: Date | null;
  release_frequency?: ReleaseFrequency | null;
}

export interface RawChainLog {
  blockNumber: number;
  transactionHash: string;
  topics: string[];
  data: string;
}

export interface RawChainBlock {
  number: number;
  timestamp: number;
}

export interface ChainProvider {
  getLogs(
    contractAddress: string,
    fromBlock: number,
    toBlock: number
  ): Promise<RawChainLog[]>;
  getBlock(blockNumber: number): Promise<RawChainBlock | null>;
}

export interface ParsedUnlockEvent {
  event_type: UnlockEventType;
  amount: string;
  block_number: number;
  tx_hash: string;
  timestamp: Date;
  recipient_address?: string | null;
}

export interface RealSellableSupplyResult {
  token_symbol: string;
  scheduled_unlock_amount: number;
  claimed_amount: number;
  sellable_amount: number;
  percent_sellable: number;
}
