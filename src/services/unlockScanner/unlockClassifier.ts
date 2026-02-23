/**
 * Classify unlock events: MINT_EMISSION, CLIFF_UNLOCK, LINEAR_UNLOCK, TREASURY_RELEASE, UNKNOWN_LARGE.
 */

export type UnlockEventType =
  | "MINT_EMISSION"
  | "CLIFF_UNLOCK"
  | "LINEAR_UNLOCK"
  | "TREASURY_RELEASE"
  | "UNKNOWN_LARGE";

export interface ClassifiedUnlockEvent {
  type: UnlockEventType;
  timestamp: number;
  amount: number;
}

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Classify each transfer: from zero = MINT; from vesting + one-time large = CLIFF; periodic = LINEAR;
 * from treasury = TREASURY_RELEASE; else large = UNKNOWN_LARGE.
 */
export function classifyUnlockEvents(
  transferLogs: Array<{ from: string; to: string; amount: number; timestamp: number }>,
  vestingWallets: Set<string>,
  treasuryWallets: Set<string>,
  largeTransferThreshold: number
): ClassifiedUnlockEvent[] {
  const out: ClassifiedUnlockEvent[] = [];
  for (const log of transferLogs) {
    const from = log.from.toLowerCase();
    const ts = Number.isFinite(log.timestamp) ? log.timestamp : 0;
    const amount = Math.max(0, log.amount);

    if (from === ZERO) {
      out.push({ type: "MINT_EMISSION", timestamp: ts, amount });
      continue;
    }
    if (treasuryWallets.has(from)) {
      out.push({ type: "TREASURY_RELEASE", timestamp: ts, amount });
      continue;
    }
    if (vestingWallets.has(from)) {
      if (amount >= largeTransferThreshold) {
        out.push({ type: "CLIFF_UNLOCK", timestamp: ts, amount });
      } else {
        out.push({ type: "LINEAR_UNLOCK", timestamp: ts, amount });
      }
      continue;
    }
    if (amount >= largeTransferThreshold) {
      out.push({ type: "UNKNOWN_LARGE", timestamp: ts, amount });
    }
  }
  return out;
}
