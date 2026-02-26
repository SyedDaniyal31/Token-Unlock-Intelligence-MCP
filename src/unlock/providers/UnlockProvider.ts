/**
 * Unlock Provider contract: every unlock source implements this interface.
 * Chain-agnostic; no RPC/DB coupling in the contract.
 */

import type { AssetMetadata } from "../../core/assetResolver.js";

export interface NormalizedUnlockEvent {
  token_symbol: string;
  unlock_timestamp: number;
  unlock_amount: number;
  unlock_percent?: number;
  source: string;
}

export interface UnlockFetchResult {
  success: boolean;
  source: string;
  events: NormalizedUnlockEvent[];
  next_unlock_timestamp?: number | null;
  /** Provider confidence 0–1; used to weight unlock in SSI. */
  confidence_score?: number;
  error?: string;
  /** True when provider returned HTTP 429 (rate limited). */
  rate_limited?: boolean;
}

export interface UnlockProvider {
  name: string;
  supports(asset: AssetMetadata): boolean;
  fetchUnlocks(asset: AssetMetadata): Promise<UnlockFetchResult>;
}
