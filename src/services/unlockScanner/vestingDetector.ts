/**
 * Heuristic vesting wallet detection: >5% holders with periodic/similar transfers to multiple recipients.
 */

import type { NormalizedLog } from "./chainClient.js";

const ZERO_TOPIC = "0x0000000000000000000000000000000000000000000000000000000000000000";

function parseValue(data: string): bigint {
  if (!data || data === "0x") return BigInt(0);
  try {
    const s = data.startsWith("0x") ? data.slice(2) : data;
    if (!/^[0-9a-fA-F]+$/.test(s)) return BigInt(0);
    return BigInt("0x" + s);
  } catch {
    return BigInt(0);
  }
}

function addressFromTopic(topic: string | undefined): string {
  if (!topic || typeof topic !== "string") return "0x0000000000000000000000000000000000000000";
  const s = topic.startsWith("0x") ? topic.slice(2) : topic;
  const padded = s.slice(-40);
  return "0x" + padded.toLowerCase().padStart(40, "0");
}

export interface VestingEvent {
  timestamp: number;
  amount: number;
  from: string;
}

export interface VestingDetectorResult {
  vestingWallets: string[];
  vestingEvents: VestingEvent[];
  patternType: "linear" | "cliff" | "unknown";
  cliffDetected: boolean;
  vestingConfidenceScore: number;
}

/**
 * Identify wallets that moved >5% supply (proxy for large holders); track their outgoing transfers.
 * If periodic, similar amounts, multiple recipients → vesting.
 * Never throws.
 */
export function detectVesting(
  transferLogs: Array<{ from: string; to: string; amount: number; blockNumber: number; timestamp: number }>,
  totalSupply: number,
  _decimals: number
): VestingDetectorResult {
  const supplySafe = Math.max(1, totalSupply);
  const threshold5 = supplySafe * 0.05;

  const sentByFrom = new Map<string, number>();
  for (const log of transferLogs) {
    const from = log.from.toLowerCase();
    if (from === "0x0000000000000000000000000000000000000000") continue;
    sentByFrom.set(from, (sentByFrom.get(from) ?? 0) + log.amount);
  }

  const bigHolders = new Set<string>();
  for (const [addr, sent] of sentByFrom) {
    if (sent >= threshold5) bigHolders.add(addr);
  }

  const outboundByFrom = new Map<string, Array<{ amount: number; timestamp: number; to: string }>>();
  for (const log of transferLogs) {
    const from = log.from.toLowerCase();
    if (from === "0x0000000000000000000000000000000000000000" || !bigHolders.has(from)) continue;
    const list = outboundByFrom.get(from) ?? [];
    list.push({ amount: log.amount, timestamp: log.timestamp, to: log.to.toLowerCase() });
    outboundByFrom.set(from, list);
  }

  const vestingWallets: string[] = [];
  const vestingEvents: VestingEvent[] = [];
  const confidenceScores: number[] = [];
  let patternType: "linear" | "cliff" | "unknown" = "unknown";
  let cliffDetected = false;

  function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n));
  }

  for (const [wallet, events] of outboundByFrom) {
    if (events.length < 2) continue;
    const amounts = events.map((e) => e.amount);
    const timestamps = events.map((e) => e.timestamp).sort((a, b) => a - b);
    const recipients = new Set(events.map((e) => e.to));
    const meanAmount = amounts.reduce((s, a) => s + a, 0) / amounts.length;
    const variance = amounts.reduce((s, a) => s + (a - meanAmount) ** 2, 0) / amounts.length;
    const cv = meanAmount > 0 ? Math.sqrt(variance) / meanAmount : 1;
    const intervals: number[] = [];
    for (let i = 1; i < timestamps.length; i++) {
      intervals.push(timestamps[i]! - timestamps[i - 1]!);
    }
    const meanInterval = intervals.length > 0 ? intervals.reduce((s, x) => s + x, 0) / intervals.length : 0;
    const intervalCv = meanInterval > 0 && intervals.length > 1
      ? Math.sqrt(intervals.reduce((s, x) => s + (x - meanInterval) ** 2, 0) / intervals.length) / meanInterval
      : 1;
    const similarAmounts = cv < 0.4;
    const periodic = intervalCv < 0.5 && meanInterval > 86400;
    const multiRecipient = recipients.size >= 2;
    if (similarAmounts && (periodic || multiRecipient)) {
      vestingWallets.push(wallet);
      for (const e of events) {
        vestingEvents.push({ timestamp: e.timestamp, amount: e.amount, from: wallet });
      }
      if (cv < 0.4 && periodic) patternType = "linear";
      const maxAmount = Math.max(...amounts);
      if (maxAmount > meanAmount * 2.5) cliffDetected = true;
      const scoreInterval = Number.isFinite(intervalCv) ? Math.max(0, 100 - intervalCv * 100) : 0;
      const scoreAmount = Number.isFinite(cv) ? Math.max(0, 100 - cv * 250) : 0;
      const scoreRecipient = recipients.size <= 1 ? 0 : Math.min(100, (recipients.size - 1) * 50);
      const combined = (scoreInterval + scoreAmount + scoreRecipient) / 3;
      confidenceScores.push(clamp(Number.isFinite(combined) ? combined : 0, 0, 100));
    }
  }

  if (cliffDetected && patternType === "unknown") patternType = "cliff";
  const vestingConfidenceScore =
    confidenceScores.length > 0
      ? Math.round(clamp(confidenceScores.reduce((s, x) => s + x, 0) / confidenceScores.length, 0, 100))
      : 0;
  return {
    vestingWallets,
    vestingEvents,
    patternType,
    cliffDetected,
    vestingConfidenceScore: Number.isFinite(vestingConfidenceScore) ? Math.max(0, Math.min(100, vestingConfidenceScore)) : 0,
  };
}

/**
 * Build transfer list from NormalizedLog[] (Transfer topic0). Decode from/to/amount; include timestamp when available.
 */
export function buildTransferList(
  logs: NormalizedLog[],
  decimals: number
): Array<{ from: string; to: string; amount: number; blockNumber: number; timestamp: number }> {
  const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const divisor = 10 ** (decimals >= 0 && decimals <= 255 ? decimals : 18);
  const out: Array<{ from: string; to: string; amount: number; blockNumber: number; timestamp: number }> = [];
  for (const log of logs) {
    if (log.topics[0] !== TRANSFER_TOPIC) continue;
    const from = addressFromTopic(log.topics[1]);
    const to = addressFromTopic(log.topics[2]);
    const raw = parseValue(log.data);
    const amount = divisor > 0 ? Number(raw) / divisor : 0;
    out.push({
      from,
      to,
      amount,
      blockNumber: log.blockNumber,
      timestamp: log.timestamp ?? 0,
    });
  }
  return out;
}
