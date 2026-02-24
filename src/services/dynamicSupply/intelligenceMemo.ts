/**
 * Dynamic Intelligence Memoization Layer: reuse recent dynamic analysis results
 * when blockchain state has not materially changed. Sits above supply cache;
 * only successful full runs are memoized.
 */

import type { DynamicSupplyOutput } from "./dynamicSupplyEngine.js";

function deepClone<T>(obj: T): T {
  return structuredClone(obj);
}

function deepFreeze<T>(obj: T): T {
  if (obj !== null && typeof obj === "object" && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const key of Object.keys(obj as Record<string, unknown>)) {
      const value = (obj as Record<string, unknown>)[key];
      if (value !== null && typeof value === "object") {
        deepFreeze(value);
      }
    }
  }
  return obj;
}

export interface MemoEntry {
  result: DynamicSupplyOutput;
  blockNumber: number;
  timestamp: number;
}

const memo = new Map<string, MemoEntry>();

const MEMO_TTL_MS = 60_000;
const BLOCK_DRIFT_THRESHOLD = 3;

/**
 * Return cached result if entry exists, is within TTL, and block drift is acceptable.
 * Always returns a clone so callers cannot mutate the memo.
 */
export function getMemoizedResult(
  key: string,
  currentBlock: number
): DynamicSupplyOutput | null {
  const entry = memo.get(key);
  if (entry == null) return null;
  if (Date.now() - entry.timestamp >= MEMO_TTL_MS) return null;
  if (Math.abs(entry.blockNumber - currentBlock) > BLOCK_DRIFT_THRESHOLD) return null;
  return deepClone(entry.result);
}

/**
 * Store a successful run for reuse. Do not call for aborted or timeout results.
 * Stores a deep-frozen clone so the internal cache cannot be mutated at any depth.
 */
export function setMemoizedResult(
  key: string,
  blockNumber: number,
  result: DynamicSupplyOutput
): void {
  memo.set(key, {
    result: deepFreeze(deepClone(result)) as DynamicSupplyOutput,
    blockNumber,
    timestamp: Date.now(),
  });
}
