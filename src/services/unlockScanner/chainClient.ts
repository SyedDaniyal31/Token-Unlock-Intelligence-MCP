/**
 * Unified log fetching for ETH, BSC, ARB.
 * Uses Etherscan API V2 unified endpoint or RPC eth_getLogs when available.
 * Timeout-protected; block-range chunking; no full-chain scans.
 */


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

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY ?? "";
const ETHERSCAN_V2_BASE = "https://api.etherscan.io/v2/api";

function getRpcUrl(chain: UnlockScannerChain): string | undefined {
  const url =
    chain === "ethereum"
      ? (process.env.ETH_RPC_URL ?? process.env.RPC_URL ?? "").trim()
      : chain === "bsc"
        ? (process.env.BSC_RPC_URL ?? "").trim()
        : (process.env.ARB_RPC_URL ?? "").trim();
  return url !== "" ? url : undefined;
}

async function tryRpcCall<T>(
  rpcUrl: string | undefined,
  body: unknown,
  timeoutMs: number
): Promise<T | null> {
  if (!rpcUrl) return null;
  try {
    const response = await withTimeout(
      fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      timeoutMs
    );
    if (!response.ok) return null;
    const json = (await response.json()) as { error?: unknown; result?: T | null };
    if (!json || json.error != null || json.result == null) return null;
    return json.result as T;
  } catch {
    return null;
  }
}

function getChainId(chain: string): number {
  switch (chain) {
    case "ethereum":
      return 1;
    case "bsc":
      return 56;
    case "arbitrum":
      return 42161;
    default:
      throw new Error(`Unsupported chain: ${chain}`);
  }
}

function buildEtherscanV2Url(
  chain: string,
  params: Record<string, string | number>
): string {
  const chainid = getChainId(chain);
  const searchParams = new URLSearchParams({
    chainid: String(chainid),
    ...Object.fromEntries(
      Object.entries(params).map(([k, v]) => [k, String(v)])
    ),
  });
  if (ETHERSCAN_API_KEY.trim() !== "") {
    searchParams.append("apikey", ETHERSCAN_API_KEY.trim());
  }
  return `${ETHERSCAN_V2_BASE}?${searchParams.toString()}`;
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

async function getCurrentBlockViaExplorer(chain: UnlockScannerChain): Promise<number> {
  const url = buildEtherscanV2Url(chain, {
    module: "proxy",
    action: "eth_blockNumber",
  });
  const res = await withTimeout(fetch(url), REQUEST_TIMEOUT_MS);
  if (!res.ok) return 0;
  const data = (await res.json()) as { result?: string };
  const hex = data?.result;
  return hex ? parseBlockNumber(hex) : 0;
}

/**
 * Returns current block number. RPC first, then Etherscan V2 fallback. Never throws; returns 0 on failure.
 */
export async function getCurrentBlock(chain: UnlockScannerChain): Promise<number> {
  const rpcUrl = getRpcUrl(chain);
  const rpcResult = await tryRpcCall<string>(
    rpcUrl,
    { jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 },
    REQUEST_TIMEOUT_MS
  );
  if (rpcResult != null && typeof rpcResult === "string") {
    const n = parseBlockNumber(rpcResult);
    if (n > 0) return n;
  }
  try {
    return await getCurrentBlockViaExplorer(chain);
  } catch {
    return 0;
  }
}

interface EthGetLogsItem {
  blockNumber?: string;
  data?: string;
  topics?: string[];
}

function buildTopicsForRpc(topics: GetLogsParams["topics"]): string[] | undefined {
  const out: string[] = [];
  const arr = topics ?? [];
  for (let i = 0; i < 4; i++) {
    const t = arr[i];
    if (t == null || t === "") continue;
    const v = Array.isArray(t) ? t[0] : t;
    if (v != null && String(v).trim() !== "") out.push(String(v).trim());
  }
  return out.length > 0 ? out : undefined;
}

function normalizeRpcLogs(logs: EthGetLogsItem[]): NormalizedLog[] {
  const out: NormalizedLog[] = [];
  for (const log of logs) {
    out.push({
      blockNumber: parseBlockNumber(log.blockNumber ?? "0"),
      data: typeof log.data === "string" ? log.data : "0x",
      topics: Array.isArray(log.topics) ? log.topics : [],
    });
  }
  return out;
}

async function fetchOneChunkViaExplorer(
  chain: UnlockScannerChain,
  address: string,
  fromBlock: number,
  toBlock: number,
  topics: (string | string[] | null)[]
): Promise<NormalizedLog[]> {
  const v2Params: Record<string, string | number> = {
    module: "logs",
    action: "getLogs",
    address,
    fromBlock: fromBlock,
    toBlock: toBlock,
  };
  const t0 = topics[0] != null ? (Array.isArray(topics[0]) ? topics[0][0] : topics[0]) : null;
  if (t0 != null && String(t0).trim() !== "") v2Params.topic0 = t0;
  const t1 = topics[1] != null ? (Array.isArray(topics[1]) ? topics[1][0] : topics[1]) : null;
  if (t1 != null && String(t1).trim() !== "") v2Params.topic1 = t1;
  const t2 = topics[2] != null ? (Array.isArray(topics[2]) ? topics[2][0] : topics[2]) : null;
  if (t2 != null && String(t2).trim() !== "") v2Params.topic2 = t2;
  const t3 = topics[3] != null ? (Array.isArray(topics[3]) ? topics[3][0] : topics[3]) : null;
  if (t3 != null && String(t3).trim() !== "") v2Params.topic3 = t3;
  const url = buildEtherscanV2Url(chain, v2Params);
  const res = await withTimeout(fetch(url), REQUEST_TIMEOUT_MS);
  if (!res.ok) return [];
  const data = (await res.json()) as { result?: Array<{ blockNumber?: string; data?: string; topics?: string[]; timeStamp?: string }> };
  const list = Array.isArray(data?.result) ? data.result : [];
  const chunkOut: NormalizedLog[] = [];
  for (const log of list) {
    let timestamp: number | undefined;
    const ts = log.timeStamp;
    if (ts !== undefined && ts !== null) {
      const n = typeof ts === "string" ? (ts.startsWith("0x") ? parseInt(ts, 16) : parseInt(ts, 10)) : Number(ts);
      timestamp = Number.isFinite(n) ? n : undefined;
    }
    chunkOut.push({
      blockNumber: parseBlockNumber(log.blockNumber ?? "0"),
      data: typeof log.data === "string" ? log.data : "0x",
      topics: Array.isArray(log.topics) ? log.topics : [],
      timestamp,
    });
  }
  return chunkOut;
}

async function getLogsViaExplorer(
  chain: UnlockScannerChain,
  params: GetLogsParams
): Promise<NormalizedLog[]> {
  const address = params.address.startsWith("0x") ? params.address : "0x" + params.address;
  const all: NormalizedLog[] = [];
  const from = params.fromBlock;
  const to = params.toBlock;
  const topics = params.topics ?? [];
  for (let f = from; f <= to; f += CHUNK_SIZE) {
    const t = Math.min(f + CHUNK_SIZE - 1, to);
    const chunkLogs = await fetchOneChunkViaExplorer(chain, address, f, t, topics);
    for (const log of chunkLogs) all.push(log);
  }
  return all;
}

/**
 * Get block timestamp. RPC first, then Etherscan V2 fallback. Returns 0 on failure.
 */
export async function getBlockTimestamp(chain: UnlockScannerChain, blockNumber: number): Promise<number> {
  const rpcUrl = getRpcUrl(chain);
  const rpcResult = await tryRpcCall<{ timestamp?: string }>(
    rpcUrl,
    {
      jsonrpc: "2.0",
      method: "eth_getBlockByNumber",
      params: ["0x" + blockNumber.toString(16), false],
      id: 1,
    },
    REQUEST_TIMEOUT_MS
  );
  if (rpcResult != null && rpcResult.timestamp != null) {
    const n = parseBlockNumber(rpcResult.timestamp);
    if (Number.isFinite(n)) return n;
  }
  try {
    const url = buildEtherscanV2Url(chain, {
      module: "proxy",
      action: "eth_getBlockByNumber",
      tag: "0x" + blockNumber.toString(16),
      boolean: "false",
    });
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
 * Fetch logs in range with optional topic filter. RPC first per chunk; after >2 RPC failures use explorer for remaining chunks.
 * Chunked; timeout per request. Returns normalized logs; never throws (returns [] on failure).
 */
export async function getLogs(
  chain: UnlockScannerChain,
  params: GetLogsParams
): Promise<NormalizedLog[]> {
  const address = params.address.startsWith("0x") ? params.address : "0x" + params.address;
  const from = params.fromBlock;
  const to = params.toBlock;
  const topics = params.topics ?? [];
  const topicsForRpc = buildTopicsForRpc(params.topics);
  const rpcUrl = getRpcUrl(chain);
  const all: NormalizedLog[] = [];
  let rpcFailures = 0;
  let useExplorerOnly = false;

  for (let f = from; f <= to; f += CHUNK_SIZE) {
    const t = Math.min(f + CHUNK_SIZE - 1, to);
    if (useExplorerOnly) {
      const chunkLogs = await fetchOneChunkViaExplorer(chain, address, f, t, topics);
      for (const log of chunkLogs) all.push(log);
      continue;
    }
    const rpcBody = {
      jsonrpc: "2.0" as const,
      method: "eth_getLogs" as const,
      params: [
        {
          address,
          fromBlock: "0x" + f.toString(16),
          toBlock: "0x" + t.toString(16),
          ...(topicsForRpc ? { topics: topicsForRpc } : {}),
        },
      ],
      id: 1,
    };
    const rpcResult = await tryRpcCall<EthGetLogsItem[]>(rpcUrl, rpcBody, REQUEST_TIMEOUT_MS);
    if (rpcResult != null && Array.isArray(rpcResult)) {
      for (const log of normalizeRpcLogs(rpcResult)) all.push(log);
    } else {
      rpcFailures += 1;
      if (rpcFailures > 2) useExplorerOnly = true;
      const chunkLogs = await fetchOneChunkViaExplorer(chain, address, f, t, topics);
      for (const log of chunkLogs) all.push(log);
    }
  }

  return all;
}
