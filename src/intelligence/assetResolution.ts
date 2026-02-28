/**
 * Asset Resolution Layer (mandatory first step).
 * Classifies token before any RPC or unlock API. No RPC or unlock API calls inside.
 */

import { fetchCoinGeckoData, normalizeCoinGeckoChainToSlug } from "../services/marketData/coingeckoClient.js";
import { resolveTokenBySymbol, createUnlockTokenRegistry, SUPPORTED_CHAINS } from "../utils/tokenResolver.js";

export type ChainSlug = "ethereum" | "bsc" | "arbitrum" | "base" | "unsupported";

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
  /** Human-readable platform name when chain is unsupported (e.g. solana, bitcoin); for display only. */
  platform_display_name?: string;
}

const SUPPORTED_SET = new Set<string>(SUPPORTED_CHAINS);

/** Known EVM tokens that CoinGecko/registry may miss; symbol → chain + contract. */
const KNOWN_EVM_SYMBOLS: Record<string, { chain: ChainSlug; contract_address: string }> = {
  SOPH: { chain: "ethereum", contract_address: "0x0000000000004946c0e9F43F4Dee607b0eF1fA1c" },
  BEAT: { chain: "bsc", contract_address: "0xcf3232B85b43BCa90E51D38cc06Cc8bB8C8A3E36" },
  ONDO: { chain: "ethereum", contract_address: "0xfAbA6f8e4a5E8Ab82F62fe7C39859FA577269BE3" },
};

/** Symbols from manual_registry.csv; when present, allow calendar-only path (unlock dates from ManualRegistry). */
const MANUAL_REGISTRY_SYMBOLS = new Set<string>([
  "2MOON", "2Z", "3-MAR", "5IRE", "A1X", "ABYS", "ACA", "ACE", "ACM", "AFG", "AGG", "AGT", "AI", "AIA", "AIBOT", "AIN",
  "ALLO", "ALPHA", "ALT", "ALTD", "AMBO", "ANIM", "ANIME", "AP3X", "APE", "APPA", "ARBI", "ARC", "ARIA", "ASR", "ASTER",
  "ATA", "ATM", "ATPAY", "ATS", "AVA", "AVAIL", "AVTM", "AXL", "AXT", "AZUR", "AZY", "BAR", "BARD", "BARS", "BAY", "BBBTC",
  "BBL", "BCUT", "BD20", "BEAT", "BEE", "BERA", "BFT", "BIGTIME", "BLESS", "BLS", "BOOP", "BOT", "BOX", "BREV", "BTCLE",
  "BTG", "BTR", "BTW", "BUBBLE", "BULLA", "BWLD", "C", "CARV", "CAT", "CATGOLD", "CATI", "CHAPZ", "CHECK", "CO", "COA",
  "COBE", "CRO", "CROS", "CSW", "CTT", "CU", "CUDIS", "DBR", "DECHAT", "DELABS", "DEP", "DGC", "DHN", "DIA", "DIGI",
  "DINW", "DL", "DMC", "DREP", "DRIFT", "DUEL", "DUET", "DYNA", "E2P", "EARN", "EDEN", "EDU", "EGO", "ELDE", "EPIK",
  "EPIKO", "EPT", "ESPORTS", "ETAN", "EVO", "EXVG", "F", "FANX", "FBX", "FHE", "FJO", "FLOCK", "FNTR", "FOGO", "FOREST",
  "FP", "FRA", "FRAG", "FTR", "G", "G3", "GAIA", "GAIX", "GATA", "GENE", "GFAL", "GOAL", "GOD", "GODS", "GOHOME", "GPS",
  "GPT", "GRFT", "GROW", "GUA", "H", "H1", "HAEDAL", "HAO", "HEMI", "HGPT", "HMND", "HOLO", "HOME", "HOOK", "HUMA", "HUT",
  "ID", "IDNG", "IDOS", "IKA", "INFRA", "INSP", "IO", "IRL", "ISME", "IVPAY", "JACKSON", "JCT", "JET", "JOJO", "JTO",
  "JUICE", "JUV", "K", "KAITO", "KARATE", "KARRAT", "KAT", "KITE", "KO", "KPN", "KULA", "LA", "LAYER", "LBP", "LETIT",
  "LF", "LINEA", "LISA", "LISTA", "LITT", "LL", "LMR", "LN", "LNQ", "LOE", "LONG", "LRT", "LUMIA", "LUX", "LVN", "MAGMA",
  "MAMO", "MANTA", "MAS", "MATTLE", "MAVIA", "MBG", "MBOX", "MCH", "MERC", "MERL", "MGL", "MIA", "MIRA", "MITO", "MLN",
  "MODE", "MOJO", "MON", "MONI", "MOT", "MOVE", "MRLN", "MSTAR", "MUNITY", "MVRK", "MWXT", "MYRIA", "MYX", "N4T", "NAVX",
  "NEUROS", "NFE", "NFP", "NIL", "NKN", "NOOB", "NUUM", "O4DX", "OGN", "OIK", "OL", "OLE", "OME", "ON", "ONDO", "ORBK",
  "ORBR", "ORFY", "ORN", "ORTA", "P", "PARTI", "PAXI", "PBUX", "PDA", "PEPPER", "PEPU", "PFVS", "PIEVERSE", "PIGGY",
  "PIXEL", "PLAY", "PLUME", "PLX", "POR", "PORT3", "PORTAL", "PORTO", "POWER", "PPT", "PRAI", "PRCL", "PROMPT", "PROVE",
  "PSG", "PTU", "PUBLIC", "PUFFER", "PUMP", "PYTH", "PZP", "Q", "RADAR", "RAFT", "RAIN", "RBC", "RDAC", "RDF", "RDO",
  "REPPO", "REVO", "REZ", "RICE", "RION", "RIVER", "RLC", "RMV", "ROA", "ROSX", "RPK", "SABAI", "SABLE", "SAGA", "SAHARA",
  "SAI", "SAROS", "SCA", "SCR", "SDEX", "SEI", "SEILOR", "SENTIS", "SERAPH", "SFTY", "SHARDS", "SHARK", "SHC", "SHELL",
  "SIGN", "SIPHER", "SIXP", "SKYA", "SLAY", "SLF", "SMART", "SNSY", "SOLV", "SPACE", "SPOL", "SPT", "SQR", "SQT", "SQUAD",
  "SSNC", "STAR", "STIK", "STOP", "STRAX", "STRDY", "STRK", "SUBHUB", "SUP", "TA", "TADA", "TAKE", "TALE", "TALK", "TBOT",
  "TEA", "TEM", "THEROS", "TICS", "TIN", "TITN", "TKO", "TRALA", "TREE", "TRIO", "TROSS", "TURBOS", "UB", "UCBI", "UDS",
  "UIBT", "ULTI", "ULTIMA", "UNICE", "UPT", "UTK", "UTT", "VANA", "VAPE", "VCORE", "VDA", "VDT", "VELVET", "VIA", "VIC",
  "VOLS", "VPR", "VRTX", "VSX", "VT", "VV", "WAI", "WAL", "WBAI", "WCT", "WEB3", "WGT", "WIFI", "WLTH", "WNDR", "WOL",
  "WOM", "WOO", "X", "XAR", "XBLAZE", "XNAP", "XO", "XTER", "Y8U", "ZBCN", "ZET", "ZEUS", "ZKJ", "ZRO", "ZTX",
]);

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
 * No RPC or unlock API calls.
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
      inputChain === "ethereum" || inputChain === "bsc" || inputChain === "arbitrum" || inputChain === "base"
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
    let chain: ChainSlug =
      slug === "ethereum" || slug === "bsc" || slug === "arbitrum" || slug === "base" ? slug : "unsupported";
    let contract_address = address ?? null;

    // When CoinGecko returns unsupported chain but we have a known EVM mapping (e.g. BEAT on BSC), use it.
    if (chain === "unsupported" && symbol && KNOWN_EVM_SYMBOLS[symbol]) {
      const known = KNOWN_EVM_SYMBOLS[symbol];
      chain = known.chain;
      contract_address = known.contract_address;
    }

    const isEvm = chain !== "unsupported";
    const is_native_asset = !contract_address && (platformChain == null || !isEvm);
    const platform_display_name =
      chain === "unsupported" && cgData.platform_key
        ? String(cgData.platform_key).toLowerCase().trim()
        : undefined;

    return {
      chain_type: isEvm ? "evm" : "non_evm",
      chain,
      contract_address,
      is_native_asset,
      data_sources_available: dataSourcesForEvm(chain),
      symbol: symbol || "UNKNOWN",
      platform_display_name,
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

  // Manual registry symbols: return unsupported asset so calendar-only path can use unlock data when imported.
  const symbolNorm = symbol.replace(/^\$/, "").toUpperCase();
  if (symbolNorm && MANUAL_REGISTRY_SYMBOLS.has(symbolNorm)) {
    return {
      chain_type: "non_evm",
      chain: "unsupported",
      contract_address: null,
      is_native_asset: true,
      data_sources_available: { rpc: false, explorer: false, cryptorank: true },
      symbol: symbolNorm,
      platform_display_name: "manual_registry",
    };
  }

  // No CoinGecko id and no registry: hard failure
  return null;
}
