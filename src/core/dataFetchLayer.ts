/**
 * Data Fetch Layer: validated fetchers that never throw.
 * Each returns { success: boolean, ... }; use for integrity checks before analysis.
 */

import type { AssetMetadata } from "./assetResolver.js";
import { getRpcUrl, readErc20SupplyFromRpc } from "../services/unlockScanner/chainClient.js";
import { getSupplyFromCacheWithTimestamp, setSupplyInCache } from "../services/dynamicSupply/supplyCache.js";
import { resolveUnifiedUnlockIntelligence } from "../intelligence/unifiedUnlockResolver.js";

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
 * Fetch unlock intelligence. Never throws.
 */
export async function fetchUnlockData(asset: AssetMetadata): Promise<UnlockFetchResult> {
  if (asset.chain_type !== "evm" || asset.chain === "unsupported") {
    return { success: false };
  }
  try {
    const out = await resolveUnifiedUnlockIntelligence({
      tokenAddress: asset.contract_address ?? undefined,
      tokenSymbol: asset.symbol,
      chain: asset.chain,
    });
    const hasData =
      (out.unlockEvents != null && out.unlockEvents.length > 0) ||
      (out.nextUnlockTimestamp != null && Number.isFinite(out.nextUnlockTimestamp));
    return {
      success: true,
      source: out.source,
      unlockEvents: out.unlockEvents ?? null,
      nextUnlockTimestamp: out.nextUnlockTimestamp ?? null,
    };
  } catch {
    return { success: false };
  }
}
