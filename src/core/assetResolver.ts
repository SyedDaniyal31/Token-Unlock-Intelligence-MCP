/**
 * Asset Resolution Module (core).
 * Single entry point: classify token before any RPC or API.
 * Resolution order: 1) token_address + supported chain → EVM 2) internal registry → CoinGecko → non-EVM native when no chain/contract.
 */

import logger from "./logger.js";
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
 * If token_address and chain (ethereum|bsc|arbitrum) are provided, returns EVM immediately without CoinGecko.
 */
export async function resolveAsset(input: {
  symbol: string;
  token_address?: string;
  chain?: string;
}): Promise<AssetMetadata> {
  const symbol = (input.symbol ?? "").trim().toUpperCase();
  const token_address = (input.token_address ?? "").trim();
  const chainRaw = (input.chain ?? "").trim().toLowerCase();
  const chainSlug: ChainSlug =
    chainRaw === "ethereum" || chainRaw === "bsc" || chainRaw === "arbitrum" ? chainRaw : "unsupported";

  // STEP 1 — token_address + supported chain → always EVM; do not depend on CoinGecko
  if (token_address && chainSlug !== "unsupported") {
    const resolved: AssetMetadata = {
      symbol: symbol || (input.symbol ?? "").trim(),
      chain_type: "evm",
      chain: chainSlug,
      contract_address: token_address,
      is_native_asset: false,
      supported: true,
    };
    logger.info(
      { symbol: resolved.symbol, chain_type: resolved.chain_type, chain: resolved.chain, supported: resolved.supported },
      "ASSET_RESOLVED"
    );
    return resolved;
  }

  // STEP 2 — Only use CoinGecko/registry when token_address or chain not provided
  let result: Awaited<ReturnType<typeof resolveAssetIntelligence>> = null;
  try {
    result = await resolveAssetIntelligence({
      symbol: symbol || input.symbol,
      token_address: token_address || undefined,
      chain: chainRaw || undefined,
    });
  } catch {
    result = null;
  }

  if (result == null) {
    const resolved: AssetMetadata = {
      symbol: symbol || (input.symbol ?? "").trim(),
      chain_type: "non_evm",
      chain: "unsupported",
      contract_address: null,
      is_native_asset: true,
      supported: false,
    };
    logger.info(
      { symbol: resolved.symbol, chain_type: resolved.chain_type, chain: resolved.chain, supported: resolved.supported },
      "ASSET_RESOLVED"
    );
    return resolved;
  }

  const supported =
    result.chain_type === "evm" && result.chain !== "unsupported" && SUPPORTED_SET.has(result.chain);
  const resolved: AssetMetadata = {
    symbol: result.symbol,
    chain_type: result.chain_type,
    chain: result.chain,
    contract_address: result.contract_address,
    is_native_asset: result.is_native_asset,
    supported,
  };
  logger.info(
    { symbol: resolved.symbol, chain_type: resolved.chain_type, chain: resolved.chain, supported: resolved.supported },
    "ASSET_RESOLVED"
  );
  return resolved;
}
