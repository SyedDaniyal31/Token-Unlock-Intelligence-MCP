/**
 * Provider-based unlock engine: runs providers in order; first success with events wins.
 * Deterministic; safe fallback when no provider returns data.
 */

import type { AssetMetadata } from "../core/assetResolver.js";
import type { UnlockFetchResult, UnlockProvider } from "./providers/UnlockProvider.js";
import { defiLlamaProvider } from "./providers/DefiLlamaProvider.js";
import { manualRegistryProvider } from "./providers/ManualRegistryProvider.js";

const providers: UnlockProvider[] = [defiLlamaProvider, manualRegistryProvider];

function filterFutureAndSort(events: UnlockFetchResult["events"], nowSec: number): UnlockFetchResult["events"] {
  return events
    .filter((e) => e.unlock_timestamp > nowSec)
    .sort((a, b) => a.unlock_timestamp - b.unlock_timestamp);
}

/**
 * Resolve unlock data from the first provider that supports the asset and returns events.
 * Never throws; returns { success: false, source: "none", events: [], next_unlock_timestamp: null } when no data.
 */
export async function resolveUnlockData(asset: AssetMetadata): Promise<UnlockFetchResult> {
  const nowSec = Math.floor(Date.now() / 1000);

  try {
    for (const provider of providers) {
      if (!provider.supports(asset)) continue;

      const result = await provider.fetchUnlocks(asset);

      if (result.success && result.events.length > 0) {
        const future = filterFutureAndSort(result.events, nowSec);
        if (future.length === 0) continue;
        return {
          success: true,
          source: result.source,
          events: future,
          next_unlock_timestamp: future[0]?.unlock_timestamp ?? null,
          confidence_score: result.confidence_score,
        };
      }
    }
  } catch {
    // safe fallback
  }

  return {
    success: false,
    source: "none",
    events: [],
    next_unlock_timestamp: null,
    confidence_score: 0,
  };
}
