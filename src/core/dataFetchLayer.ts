/**
 * Data Fetch Layer: validated fetchers that never throw.
 * Each returns { success: boolean, ... }; use for integrity checks before analysis.
 */

import type { AssetMetadata } from "./assetResolver.js";
import { getRpcUrl, readErc20SupplyFromRpc } from "../services/unlockScanner/chainClient.js";
import { getSupplyFromCacheWithTimestamp, setSupplyInCache } from "../services/dynamicSupply/supplyCache.js";
import { resolveUnlockData } from "../unlock/unlockProviderEngine.js";

export interface OnchainFetchResult {
  success: boolean;
  totalSupply?: number;
  decimals?: number;
}

export interface ExplorerFetchResult {
  success: boolean;
}

export interface UnlockFetchResult {
  success: boolean;
  source?: "registry" | "external_calendar" | "scanner" | "inferred";
  unlockEvents?: { unlock_timestamp: number }[] | null;
  nextUnlockTimestamp?: number | null;
  /** Raw provider name (e.g. ManualRegistry, DefiLlama). */
  unlock_provider?: string;
  /** Provider confidence 0–1. */
  unlock_provider_confidence?: number;
}

/**
 * Fetch on-chain supply data. Never throws. Uses cache when available.
 */
export async function fetchOnchainData(asset: AssetMetadata): Promise<OnchainFetchResult> {
  if (asset.chain_type !== "evm" || !asset.contract_address || asset.chain === "unsupported") {
    return { success: false };
  }
  const chainKey = asset.chain as "ethereum" | "bsc" | "arbitrum";
  const addr = asset.contract_address;

  try {
    const cached = getSupplyFromCacheWithTimestamp(addr, chainKey);
    if (cached && cached.data.totalSupply >= 0) {
      return {
        success: true,
        totalSupply: cached.data.totalSupply,
        decimals: cached.data.decimals,
      };
    }
    const rpcUrl = getRpcUrl(chainKey);
    if (!rpcUrl) return { success: false };

    const snapshot = await readErc20SupplyFromRpc(chainKey, addr);
    if (snapshot && Number.isFinite(snapshot.totalSupply)) {
      setSupplyInCache(addr, chainKey, snapshot);
      return {
        success: true,
        totalSupply: snapshot.totalSupply,
        decimals: snapshot.decimals ?? 18,
      };
    }
  } catch {
    // never throw
  }
  return { success: false };
}

/**
 * Explorer availability for supported EVM. Never throws.
 */
export async function fetchExplorerData(_asset: AssetMetadata): Promise<ExplorerFetchResult> {
  // Explorer is used internally by scanner/chainClient; we only signal availability here.
  return { success: true };
}

/**
 * Fetch unlock intelligence via provider engine. Never throws.
 * Chain-agnostic: runs for ALL assets (EVM and non-EVM). Unlock schedules are not tied to chain support.
 */
export async function fetchUnlockData(asset: AssetMetadata): Promise<UnlockFetchResult> {
  try {
    const result = await resolveUnlockData(asset);
    const sourceMap: Record<string, "registry" | "external_calendar" | "scanner" | "inferred"> = {
      ManualRegistry: "registry",
      DefiLlama: "external_calendar",
    };
    const source = result.source === "none" ? "inferred" : (sourceMap[result.source] ?? "inferred");
    const unlockEvents =
      result.events.length > 0
        ? result.events.map((e) => ({ unlock_timestamp: e.unlock_timestamp }))
        : null;
    return {
      success: result.success,
      source,
      unlockEvents,
      nextUnlockTimestamp: result.next_unlock_timestamp ?? null,
      unlock_provider: result.source === "none" ? undefined : result.source,
      unlock_provider_confidence: result.confidence_score ?? 0,
    };
  } catch {
    return { success: false };
  }
}
