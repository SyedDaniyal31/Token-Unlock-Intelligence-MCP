/**
 * Unified log fetching for ETH, BSC, ARB.
 * Uses Etherscan/BscScan/Arbiscan free APIs or RPC eth_getLogs when available.
 * Timeout-protected; block-range chunking; no full-chain scans.
 */

import { getChainProvider } from "../../infrastructure/rpc/chainProviderFactory.js";
import type { ChainProvider, RawChainLog } from "../../core/types.js";

export type UnlockScannerChain = "ethereum" | "bsc" | "arbitrum";

export interface NormalizedLog {
  blockNumber: number;
  data: string;
  topics: string[];
  /** Unix seconds; set when available (e.g. from explorer API). */
  timestamp?: number;
}

export interface GetLogsParams {
  address: string;
  fromBlock: number;
  toBlock: number;
  topics?: (string | string[] | null)[];
}

const REQUEST_TIMEOUT_MS = 6000;
const CHUNK_SIZE = 5000;

const EXPLORER_BASE: Record<UnlockScannerChain, string> = {
  ethereum: "https://api.etherscan.io/api",
  bsc: "https://api.bscscan.com/api",
  arbitrum: "https://api.arbiscan.io/api",
};

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY ?? "";
const BSCSCAN_API_KEY = process.env.BSCSCAN_API_KEY ?? "";
const ARBISCAN_API_KEY = process.env.ARBISCAN_API_KEY ?? "";

function getExplorerApiKey(chain: UnlockScannerChain): string {
  switch (chain) {
    case "ethereum": return ETHERSCAN_API_KEY;
    case "bsc": return BSCSCAN_API_KEY;
    case "arbitrum": return ARBISCAN_API_KEY;
    default: return "";
  }
}

/** Build explorer URL with optional apikey. Never appends empty apikey; no leakage. */
function buildExplorerUrl(chain: UnlockScannerChain, queryString: string): string {
  const base = EXPLORER_BASE[chain];
  const apiKey = getExplorerApiKey(chain);
  const apiKeyParam = apiKey && String(apiKey).trim() ? `&apikey=${apiKey}` : "";
  return `${base}?${queryString}${apiKeyParam}`;
}

function toHex(n: number): string {
  return "0x" + n.toString(16);
}

function parseBlockNumber(x: string | number): number {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  const s = typeof x === "string" ? (x.startsWith("0x") ? x.slice(2) : x) : String(x);
  const n = parseInt(s, 16);
  return Number.isNaN(n) ? 0 : n;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Request timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

async function getCurrentBlockViaRpc(chain: UnlockScannerChain): Promise<number> {
  const provider = getChainProvider(chain);
  const fn = provider.getLatestBlockNumber?.bind(provider);
  if (!fn) return 0;
  const n = await withTimeout(fn(), REQUEST_TIMEOUT_MS);
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

async function getCurrentBlockViaExplorer(chain: UnlockScannerChain): Promise<number> {
  const url = buildExplorerUrl(chain, "module=proxy&action=eth_blockNumber");
  const res = await withTimeout(fetch(url), REQUEST_TIMEOUT_MS);
  if (!res.ok) return 0;
  const data = (await res.json()) as { result?: string };
  const hex = data?.result;
  return hex ? parseBlockNumber(hex) : 0;
}

/**
 * Returns current block number. RPC first, then explorer. Never throws; returns 0 on failure.
 */
export async function getCurrentBlock(chain: UnlockScannerChain): Promise<number> {
  try {
    const n = await getCurrentBlockViaRpc(chain);
    if (n > 0) return n;
  } catch {
    // ignore
  }
  try {
    return await getCurrentBlockViaExplorer(chain);
  } catch {
    return 0;
  }
}

async function getLogsViaRpc(
  chain: UnlockScannerChain,
  params: GetLogsParams
): Promise<NormalizedLog[]> {
  const provider = getChainProvider(chain) as ChainProvider;
  const from = params.fromBlock;
  const to = params.toBlock;
  const address = params.address.startsWith("0x") ? params.address : "0x" + params.address;
  const all: NormalizedLog[] = [];
  for (let f = from; f <= to; f += CHUNK_SIZE) {
    const t = Math.min(f + CHUNK_SIZE - 1, to);
    const logs = (await withTimeout(
      provider.getLogs(address, f, t),
      REQUEST_TIMEOUT_MS
    )) as RawChainLog[];
    for (const log of logs) {
      all.push({
        blockNumber: log.blockNumber,
        data: log.data ?? "0x",
        topics: Array.isArray(log.topics) ? log.topics : [],
      });
    }
  }
  return all;
}

async function getLogsViaExplorer(
  chain: UnlockScannerChain,
  params: GetLogsParams
): Promise<NormalizedLog[]> {
  const address = params.address.startsWith("0x") ? params.address : "0x" + params.address;
  const all: NormalizedLog[] = [];
  const from = params.fromBlock;
  const to = params.toBlock;
  for (let f = from; f <= to; f += CHUNK_SIZE) {
    const t = Math.min(f + CHUNK_SIZE - 1, to);
    const q = new URLSearchParams({
      module: "logs",
      action: "getLogs",
      address,
      fromBlock: String(f),
      toBlock: String(t),
    });
    if (params.topics?.length && params.topics[0]) {
      const t0 = Array.isArray(params.topics[0]) ? params.topics[0][0] : params.topics[0];
      if (t0) q.set("topic0", t0);
    }
    const url = buildExplorerUrl(chain, q.toString());
    const res = await withTimeout(fetch(url), REQUEST_TIMEOUT_MS);
    if (!res.ok) continue;
    const data = (await res.json()) as { result?: Array<{ blockNumber?: string; data?: string; topics?: string[] }> };
    const list = Array.isArray(data?.result) ? data.result : [];
    for (const log of list) {
      let timestamp: number | undefined;
      const ts = (log as { timeStamp?: string }).timeStamp;
      if (ts !== undefined && ts !== null) {
        const n = typeof ts === "string" ? (ts.startsWith("0x") ? parseInt(ts, 16) : parseInt(ts, 10)) : Number(ts);
        timestamp = Number.isFinite(n) ? n : undefined;
      }
      all.push({
        blockNumber: parseBlockNumber(log.blockNumber ?? "0"),
        data: typeof log.data === "string" ? log.data : "0x",
        topics: Array.isArray(log.topics) ? log.topics : [],
        timestamp,
      });
    }
  }
  return all;
}

/**
 * Get block timestamp. RPC first, then explorer. Returns 0 on failure.
 */
export async function getBlockTimestamp(chain: UnlockScannerChain, blockNumber: number): Promise<number> {
  try {
    const provider = getChainProvider(chain);
    const block = provider.getBlock?.bind(provider);
    if (block) {
      const b = (await withTimeout(block(blockNumber), REQUEST_TIMEOUT_MS)) as { timestamp?: number } | null;
      const ts = b?.timestamp;
      return typeof ts === "number" && Number.isFinite(ts) ? ts : 0;
    }
  } catch {
    // ignore
  }
  try {
    const hex = "0x" + blockNumber.toString(16);
    const url = buildExplorerUrl(chain, `module=proxy&action=eth_getBlockByNumber&tag=${hex}&boolean=false`);
    const res = await withTimeout(fetch(url), REQUEST_TIMEOUT_MS);
    if (!res.ok) return 0;
    const data = (await res.json()) as { result?: { timestamp?: string } };
    const ts = data?.result?.timestamp;
    return ts ? parseBlockNumber(ts) : 0;
  } catch {
    return 0;
  }
}

/**
 * Fetch logs in range with optional topic filter. Chunked; timeout per request.
 * Returns normalized logs; never throws (returns [] on failure).
 */
export async function getLogs(
  chain: UnlockScannerChain,
  params: GetLogsParams
): Promise<NormalizedLog[]> {
  try {
    const viaRpc = await getLogsViaRpc(chain, params);
    if (viaRpc.length > 0 || params.toBlock - params.fromBlock <= CHUNK_SIZE) {
      return viaRpc;
    }
  } catch {
    // fallback to explorer
  }
  try {
    return await getLogsViaExplorer(chain, params);
  } catch {
    return [];
  }
}
