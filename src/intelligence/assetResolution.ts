/**
 * Asset Resolution Layer (mandatory first step).
 * Classifies token before any RPC or unlock API. No RPC/CryptoRank calls inside.
 */

import { fetchCoinGeckoData, normalizeCoinGeckoChainToSlug } from "../services/marketData/coingeckoClient.js";
import { resolveTokenBySymbol, createUnlockTokenRegistry, SUPPORTED_CHAINS } from "../utils/tokenResolver.js";

export type ChainSlug = "ethereum" | "bsc" | "arbitrum" | "unsupported";

export interface DataSourcesAvailable {
  rpc: boolean;
  explorer: boolean;
  cryptorank: boolean;
}

export interface AssetResolutionResult {
  chain_type: "evm" | "non_evm";
  chain: ChainSlug;
  contract_address: string | null;
  is_native_asset: boolean;
  data_sources_available: DataSourcesAvailable;
  /** Normalized symbol (e.g. from CoinGecko or registry). */
  symbol: string;
}

const SUPPORTED_SET = new Set<string>(SUPPORTED_CHAINS);

/** Known EVM tokens that CoinGecko/registry may miss; symbol → chain + contract. */
const KNOWN_EVM_SYMBOLS: Record<string, { chain: ChainSlug; contract_address: string }> = {
  SOPH: { chain: "ethereum", contract_address: "0x0000000000004946c0e9F43F4Dee607b0eF1fA1c" },
};

function dataSourcesForEvm(chain: ChainSlug): DataSourcesAvailable {
  const supported = chain !== "unsupported" && SUPPORTED_SET.has(chain);
  return {
    rpc: supported,
    explorer: supported,
    cryptorank: true,
  };
}

/**
 * Resolve and classify asset from symbol (and optional address/chain).
 * Returns null on hard failure (e.g. no CoinGecko id and no registry match).
 * No RPC or CryptoRank calls.
 */
export async function resolveAsset(input: {
  symbol: string;
  token_address?: string;
  chain?: string;
}): Promise<AssetResolutionResult | null> {
  const symbol = (input.symbol ?? "").trim().toUpperCase();
  const inputAddress = (input.token_address ?? "").trim();
  const inputChain = (input.chain ?? "").trim().toLowerCase();

  if (!symbol && !inputAddress) return null;

  // Caller already provided EVM address + chain
  if (inputAddress && inputChain) {
    const slug: ChainSlug =
      inputChain === "ethereum" || inputChain === "bsc" || inputChain === "arbitrum"
        ? (inputChain as ChainSlug)
        : "unsupported";
    const isSupportedEvm = slug !== "unsupported";
    return {
      chain_type: isSupportedEvm ? "evm" : "non_evm",
      chain: slug,
      contract_address: inputAddress || null,
      is_native_asset: false,
      data_sources_available: dataSourcesForEvm(slug),
      symbol: symbol || "UNKNOWN",
    };
  }

  // Try CoinGecko first
  let cgData: Awaited<ReturnType<typeof fetchCoinGeckoData>> = null;
  try {
    cgData = await fetchCoinGeckoData(symbol || inputAddress || "UNKNOWN");
  } catch {
    cgData = null;
  }

  if (cgData) {
    const address = cgData.address ?? null;
    const platformChain = cgData.platform_chain ?? null;
    const slug = platformChain != null ? normalizeCoinGeckoChainToSlug(platformChain) : undefined;
    const chain: ChainSlug =
      slug === "ethereum" || slug === "bsc" || slug === "arbitrum" ? slug : "unsupported";
    const isEvm = chain !== "unsupported";
    const is_native_asset = !address && (platformChain == null || !isEvm);

    return {
      chain_type: isEvm ? "evm" : "non_evm",
      chain,
      contract_address: address ?? null,
      is_native_asset,
      data_sources_available: dataSourcesForEvm(chain),
      symbol: symbol || "UNKNOWN",
    };
  }

  // Fallback: registry (EVM only)
  const registry = createUnlockTokenRegistry();
  const resolved = await resolveTokenBySymbol(symbol, registry);
  if (resolved) {
    return {
      chain_type: "evm",
      chain: resolved.chain as ChainSlug,
      contract_address: resolved.address,
      is_native_asset: false,
      data_sources_available: dataSourcesForEvm(resolved.chain as ChainSlug),
      symbol: resolved.symbol,
    };
  }

  // Known EVM symbol fallback (e.g. SOPH when CoinGecko/registry miss)
  if (symbol && KNOWN_EVM_SYMBOLS[symbol]) {
    const known = KNOWN_EVM_SYMBOLS[symbol];
    return {
      chain_type: "evm",
      chain: known.chain,
      contract_address: known.contract_address,
      is_native_asset: false,
      data_sources_available: dataSourcesForEvm(known.chain),
      symbol,
    };
  }

  // No CoinGecko id and no registry: hard failure
  return null;
}
