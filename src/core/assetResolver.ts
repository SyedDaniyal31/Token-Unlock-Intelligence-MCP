/**
 * Asset Resolution Module (core).
 * Single entry point: classify token before any RPC or API.
 * Resolution order: internal registry → CoinGecko → non-EVM native when no chain/contract.
 */

import { resolveAsset as resolveAssetIntelligence } from "../intelligence/assetResolution.js";

export type ChainSlug = "ethereum" | "bsc" | "arbitrum" | "unsupported";

export interface AssetMetadata {
  symbol: string;
  chain_type: "evm" | "non_evm";
  chain: ChainSlug;
  contract_address: string | null;
  is_native_asset: boolean;
  /** True when chain_type === "evm" and chain is ethereum | bsc | arbitrum. */
  supported: boolean;
}

const SUPPORTED_CHAINS: ChainSlug[] = ["ethereum", "bsc", "arbitrum"];
const SUPPORTED_SET = new Set<string>(SUPPORTED_CHAINS);

/**
 * Resolve and classify asset. Never throws; returns metadata with supported = false on failure.
 * Resolution order: 1) internal registry 2) CoinGecko 3) no chain + no contract → non_evm native.
 */
export async function resolveAsset(input: {
  symbol: string;
  token_address?: string;
  chain?: string;
}): Promise<AssetMetadata> {
  const symbol = (input.symbol ?? "").trim().toUpperCase();
  const token_address = (input.token_address ?? "").trim();
  const chain = (input.chain ?? "").trim().toLowerCase();

  let result: Awaited<ReturnType<typeof resolveAssetIntelligence>> = null;
  try {
    result = await resolveAssetIntelligence({
      symbol: symbol || input.symbol,
      token_address: token_address || undefined,
      chain: chain || undefined,
    });
  } catch {
    result = null;
  }

  if (result == null) {
    return {
      symbol: symbol || "UNKNOWN",
      chain_type: "non_evm",
      chain: "unsupported",
      contract_address: null,
      is_native_asset: true,
      supported: false,
    };
  }

  const supported =
    result.chain_type === "evm" && result.chain !== "unsupported" && SUPPORTED_SET.has(result.chain);

  return {
    symbol: result.symbol,
    chain_type: result.chain_type,
    chain: result.chain,
    contract_address: result.contract_address,
    is_native_asset: result.is_native_asset,
    supported,
  };
}
