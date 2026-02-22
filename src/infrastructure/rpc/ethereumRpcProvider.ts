import type {
  ChainProvider,
  RawChainLog,
  RawChainBlock,
  TokenTransfer,
} from "../../core/types.js";
import logger from "../../core/logger.js";

/** ERC20 Transfer(address,address,uint256) — keccak256 */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const CONFIRMATION_DEPTH = 12;
/** Free-tier RPC (e.g. Alchemy/Infura) often allows max 10 blocks for eth_getLogs; use 10 so we don't trigger "block range too wide". */
const INITIAL_BATCH_SIZE = 10;
const MIN_BATCH_SIZE = 10;
const RPC_DELAY_MS = 100;
const MAX_RETRIES = 2;

/** RPC error phrases that trigger batch size reduction */
const ADAPTIVE_ERROR_PHRASES = [
  "query returned more than",
  "block range too wide",
  "10 block range",
  "free tier",
  "timeout",
  "time out",
  "ETIMEDOUT",
  "ECONNRESET",
];

export interface GetLogsMetrics {
  total_batches: number;
  total_logs: number;
  total_duration_ms: number;
  retries_used: number;
}

function toHex(n: number): string {
  return "0x" + n.toString(16);
}

function parseBlockNumber(hex: string): number {
  if (!hex || typeof hex !== "string") return 0;
  const s = hex.startsWith("0x") ? hex.slice(2) : hex;
  const n = parseInt(s, 16);
  return Number.isNaN(n) ? 0 : n;
}

function parseValue(data: string): string {
  if (!data || data === "0x") return "0";
  try {
    const s = data.startsWith("0x") ? data.slice(2) : data;
    if (!/^[0-9a-fA-F]+$/.test(s)) return "0";
    return String(BigInt("0x" + s));
  } catch {
    return "0";
  }
}

function addressFromTopic(topic: string | undefined): string {
  if (!topic || typeof topic !== "string") return "0x0000000000000000000000000000000000000000";
  const s = topic.startsWith("0x") ? topic.slice(2) : topic;
  const padded = s.slice(-40);
  return "0x" + padded.padStart(40, "0");
}

function parseLogIndex(hex: string | undefined): number {
  if (hex === undefined || hex === null) return 0;
  const n = parseBlockNumber(hex);
  return Number.isNaN(n) ? 0 : n;
}

function shortRequestId(): string {
  return "rpc_" + Math.random().toString(36).slice(2, 10);
}

interface EthLogRaw {
  address?: string;
  blockNumber?: string;
  transactionHash?: string;
  logIndex?: string;
  topics?: string[];
  data?: string;
}

/**
 * Deduplicate logs by (transactionHash + logIndex) and sort by (blockNumber ASC, logIndex ASC).
 * Guarantees replay safety and idempotency.
 */
function dedupeAndSortLogs(logs: RawChainLog[]): RawChainLog[] {
  const seen = new Set<string>();
  const out: RawChainLog[] = [];
  for (const log of logs) {
    const key = `${log.transactionHash}:${log.logIndex ?? 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(log);
  }
  out.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
    return (a.logIndex ?? 0) - (b.logIndex ?? 0);
  });
  return out;
}

/**
 * Decode a single eth_getLogs item as ERC20 Transfer into TokenTransfer.
 */
export function decodeTransferLog(log: EthLogRaw): TokenTransfer {
  const blockNumber = parseBlockNumber(log.blockNumber ?? "0x0");
  const txHash = log.transactionHash ?? "";
  const topics = Array.isArray(log.topics) ? log.topics : [];
  const from = addressFromTopic(topics[1]);
  const to = addressFromTopic(topics[2]);
  const value = parseValue(log.data ?? "0x");
  return {
    from,
    to,
    value,
    blockNumber,
    txHash,
  };
}

function rawLogToRawChainLog(log: EthLogRaw): RawChainLog {
  return {
    blockNumber: parseBlockNumber(log.blockNumber ?? "0x0"),
    transactionHash: log.transactionHash ?? "",
    topics: Array.isArray(log.topics) ? log.topics : [],
    data: log.data ?? "0x",
    logIndex: parseLogIndex(log.logIndex),
  };
}

function isAdaptiveError(err: Error): boolean {
  const msg = (err.message || "").toLowerCase();
  return ADAPTIVE_ERROR_PHRASES.some((p) => msg.includes(p.toLowerCase()));
}

/**
 * Institutional Ethereum RPC provider: reorg-safe, deterministic logs, adaptive batching,
 * circuit breaker, request tracing, and internal metrics.
 */
export class EthereumRpcProvider implements ChainProvider {
  private readonly rpcUrl: string;

  /** Last getLogs/getTokenTransfers metrics (internal only; not on ChainProvider). */
  private lastMetrics: GetLogsMetrics = {
    total_batches: 0,
    total_logs: 0,
    total_duration_ms: 0,
    retries_used: 0,
  };

  constructor(rpcUrl?: string) {
    const url = (rpcUrl ?? process.env.RPC_URL ?? "").trim();
    if (process.env.NODE_ENV === "production" && !url) {
      throw new Error("RPC_URL is required in production for EthereumRpcProvider");
    }
    if (!url) {
      throw new Error("RPC_URL is required for EthereumRpcProvider");
    }
    this.rpcUrl = url;
  }

  /** Expose last getLogs metrics for internal use only (not part of ChainProvider). */
  getLastGetLogsMetrics(): GetLogsMetrics {
    return { ...this.lastMetrics };
  }

  private delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * Latest block number via eth_blockNumber. For chain freshness metadata.
   */
  async getLatestBlockNumber(): Promise<number> {
    const hex = await this.rpc<string>("eth_blockNumber", []);
    return parseBlockNumber(typeof hex === "string" ? hex : "0x0");
  }

  private async rpc<T>(method: string, params: unknown[], requestId?: string): Promise<T> {
    const id = requestId ?? shortRequestId();
    const start = Date.now();
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(this.rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method,
            params,
          }),
        });
        const data = (await res.json()) as { result?: T; error?: { message: string; code?: number } };
        if (data.error) {
          throw new Error(data.error.message ?? `RPC error ${data.error.code ?? ""}`);
        }
        const duration = Date.now() - start;
        logger.debug({ requestId: id, method, duration_ms: duration }, "RPC call");
        return data.result as T;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        const duration = Date.now() - start;
        logger.warn(
          { requestId: id, method, attempt: attempt + 1, duration_ms: duration, err: lastErr.message },
          "RPC call failed"
        );
        if (attempt < MAX_RETRIES) {
          await this.delay(RPC_DELAY_MS * (attempt + 1));
        }
      }
    }
    throw lastErr ?? new Error("RPC failed");
  }

  /**
   * Internal: fetch logs with reorg cap, adaptive batching, circuit breaker, tracing, metrics.
   * Returns deterministically ordered, deduplicated logs.
   */
  private async fetchLogsInternal(
    contractAddress: string,
    fromBlock: number,
    toBlock: number,
    topics?: string[],
    requestId?: string
  ): Promise<RawChainLog[]> {
    const reqId = requestId ?? shortRequestId();
    const overallStart = Date.now();
    this.lastMetrics = { total_batches: 0, total_logs: 0, total_duration_ms: 0, retries_used: 0 };

    let latestBlock: number;
    try {
      latestBlock = await this.getLatestBlockNumber();
    } catch (err) {
      logger.warn({ requestId: reqId, err: err instanceof Error ? err.message : String(err) }, "getLatestBlockNumber failed; using requested toBlock");
      latestBlock = toBlock + CONFIRMATION_DEPTH;
    }

    const safeToBlock = Math.min(toBlock, Math.max(0, latestBlock - CONFIRMATION_DEPTH));
    if (safeToBlock < fromBlock) {
      logger.debug({ requestId: reqId, fromBlock, safeToBlock, latestBlock }, "Range fully behind confirmation depth");
      return [];
    }

    let batchSize = INITIAL_BATCH_SIZE;
    const all: RawChainLog[] = [];
    let consecutiveFailures = 0;
    let retriesUsed = 0;

    const batches: Array<{ from: number; to: number }> = [];
    for (let f = fromBlock; f <= safeToBlock; f += batchSize) {
      const t = Math.min(f + batchSize - 1, safeToBlock);
      batches.push({ from: f, to: t });
    }

    for (let i = 0; i < batches.length; i++) {
      let currentBatchSize = batchSize;
      if (consecutiveFailures >= 3) {
        logger.error(
          { requestId: reqId, consecutiveFailures, partial_logs: all.length },
          "Circuit breaker: 3 consecutive batch failures; returning partial logs"
        );
        break;
      }

      const { from, to } = batches[i];
      const batchStart = Date.now();
      let success = false;

      while (currentBatchSize >= MIN_BATCH_SIZE) {
        const subRanges: Array<{ from: number; to: number }> = [];
        for (let f = from; f <= to; f += currentBatchSize) {
          const t = Math.min(f + currentBatchSize - 1, to);
          subRanges.push({ from: f, to: t });
        }

        let batchOk = true;
        for (const { from: f, to: t } of subRanges) {
          try {
            const raw = await this.rpc<EthLogRaw[] | null>(
              "eth_getLogs",
              [
                {
                  address: contractAddress,
                  fromBlock: toHex(f),
                  toBlock: toHex(t),
                  ...(topics && topics.length > 0 ? { topics } : {}),
                },
              ],
              reqId
            );
            const duration = Date.now() - batchStart;
            logger.debug(
              { requestId: reqId, fromBlock: f, toBlock: t, batchSize: currentBatchSize, duration_ms: duration },
              "getLogs batch"
            );
            if (Array.isArray(raw)) {
              for (const log of raw) {
                all.push(rawLogToRawChainLog(log));
              }
            }
            this.lastMetrics.total_batches += 1;
            this.lastMetrics.total_logs = all.length;
            consecutiveFailures = 0;
          } catch (err) {
            const e = err instanceof Error ? err : new Error(String(err));
            if (isAdaptiveError(e) && currentBatchSize > MIN_BATCH_SIZE) {
              currentBatchSize = Math.max(MIN_BATCH_SIZE, Math.floor(currentBatchSize * 0.5));
              batchSize = currentBatchSize;
              retriesUsed += 1;
              this.lastMetrics.retries_used = retriesUsed;
              logger.warn(
                { requestId: reqId, fromBlock: from, toBlock: to, newBatchSize: currentBatchSize },
                "Adaptive batch: reducing size and retrying"
              );
              batchOk = false;
              break;
            }
            consecutiveFailures += 1;
            logger.error(
              { requestId: reqId, fromBlock: f, toBlock: t, err: e.message },
              "getLogs batch failed; returning partial results"
            );
            batchOk = false;
            break;
          }
        }
        if (batchOk) {
          success = true;
          break;
        }
        if (currentBatchSize <= MIN_BATCH_SIZE) break;
      }

      if (!success) {
        consecutiveFailures += 1;
      }

      if (i < batches.length - 1) {
        await this.delay(RPC_DELAY_MS);
      }
    }

    this.lastMetrics.total_duration_ms = Date.now() - overallStart;
    this.lastMetrics.total_logs = all.length;

    return dedupeAndSortLogs(all);
  }

  /**
   * getLogs: reorg-safe (toBlock capped to latest - CONFIRMATION_DEPTH), deterministic order,
   * adaptive batching, circuit breaker, request tracing. ChainProvider interface unchanged.
   */
  async getLogs(
    contractAddress: string,
    fromBlock: number,
    toBlock: number
  ): Promise<RawChainLog[]> {
    return this.fetchLogsInternal(contractAddress, fromBlock, toBlock);
  }

  /** eth_call for vesting contract detection (to, data hex). */
  async call(to: string, data: string): Promise<string> {
    const requestId = shortRequestId();
    const start = Date.now();
    try {
      const result = await this.rpc<string>("eth_call", [
        { to: to.toLowerCase(), data: data.startsWith("0x") ? data : "0x" + data },
        "latest",
      ], requestId);
      logger.debug({ requestId, duration_ms: Date.now() - start }, "eth_call");
      return typeof result === "string" ? result : "0x";
    } catch (err) {
      logger.warn({ requestId, err: err instanceof Error ? err.message : String(err), to }, "eth_call failed");
      return "0x";
    }
  }

  async getBlock(blockNumber: number): Promise<RawChainBlock | null> {
    const requestId = shortRequestId();
    const start = Date.now();
    try {
      const raw = await this.rpc<{ number: string; timestamp: string } | null>(
        "eth_getBlockByNumber",
        [toHex(blockNumber), false],
        requestId
      );
      logger.debug({ requestId, blockNumber, duration_ms: Date.now() - start }, "getBlock");
      if (!raw) return null;
      return {
        number: parseBlockNumber(raw.number),
        timestamp: parseBlockNumber(raw.timestamp),
      };
    } catch (err) {
      logger.warn({ requestId, err: err instanceof Error ? err.message : String(err), blockNumber }, "getBlock failed");
      return null;
    }
  }

  /**
   * getTokenTransfers: same institutional guarantees as getLogs (reorg-safe, dedupe, sort,
   * adaptive batching, circuit breaker). Returns decoded Transfer logs in deterministic order.
   */
  async getTokenTransfers(
    tokenAddress: string,
    fromBlock: number,
    toBlock: number
  ): Promise<TokenTransfer[]> {
    const rawLogs = await this.fetchLogsInternal(
      tokenAddress,
      fromBlock,
      toBlock,
      [TRANSFER_TOPIC]
    );
    return rawLogs.map((log) =>
      decodeTransferLog({
        blockNumber: toHex(log.blockNumber),
        transactionHash: log.transactionHash,
        logIndex: log.logIndex != null ? toHex(log.logIndex) : undefined,
        topics: log.topics,
        data: log.data,
      })
    );
  }
}
