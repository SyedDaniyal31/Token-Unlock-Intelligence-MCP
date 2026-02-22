/**
 * Centralized, case-insensitive, multi-chain token symbol resolution.
 * Single place for symbol normalization and registry lookup; used by all tools.
 */

import { getScheduleByTokenCaseInsensitive } from "../ingestion/unlockRegistry.js";

export const SUPPORTED_CHAINS = ["ethereum", "bsc", "arbitrum"] as const;
export type SupportedChain = (typeof SUPPORTED_CHAINS)[number];

export interface ResolvedToken {
  symbol: string;
  chain: string;
  address: string;
}

/**
 * Registry interface: lookup by normalized symbol and chain.
 * Implementations must not throw; return null when not found.
 */
export interface TokenRegistryType {
  lookup(symbol: string, chain: string): Promise<{ address: string } | null>;
}

/**
 * Resolve token by symbol (any case) across supported chains.
 * Priority: ethereum -> bsc -> arbitrum. Does not throw; returns null if not found on any chain.
 */
export async function resolveTokenBySymbol(
  symbol: string,
  registry: TokenRegistryType
): Promise<ResolvedToken | null> {
  const normalizedSymbol = typeof symbol === "string" ? symbol.trim().toUpperCase() : "";
  if (!normalizedSymbol) return null;

  for (const chain of SUPPORTED_CHAINS) {
    try {
      const result = await registry.lookup(normalizedSymbol, chain);
      if (result != null && typeof result.address === "string" && result.address.trim().length > 0) {
        return {
          symbol: normalizedSymbol,
          chain,
          address: result.address.trim(),
        };
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Default registry implementation using unlock_schedules (case-insensitive lookup).
 */
export function createUnlockTokenRegistry(): TokenRegistryType {
  return {
    async lookup(symbol: string, chain: string): Promise<{ address: string } | null> {
      try {
        const schedule = await getScheduleByTokenCaseInsensitive(symbol, chain);
        if (schedule?.contract_address) {
          return { address: schedule.contract_address };
        }
        return null;
      } catch {
        return null;
      }
    },
  };
}
