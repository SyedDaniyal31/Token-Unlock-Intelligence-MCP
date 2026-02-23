/**
 * Aggregate unlock metrics: pressure ratio, cliff, pattern type, emission acceleration, supply volatility.
 */

import type { MintScannerResult } from "./mintScanner.js";
import type { VestingDetectorResult } from "./vestingDetector.js";
import type { TreasuryTrackerResult } from "./treasuryTracker.js";
import type { TransferSpikeResult } from "./transferSpikeAnalyzer.js";

export interface UnlockAggregatorOutput {
  unlockPressureRatio: number;
  cliffDetected: boolean;
  unlockPatternType: string;
  emissionAccelerationScore: number;
  supplyVolatilityIndex: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Combine mint, vesting, treasury, and spike results into single metrics. Never throws.
 * vestingConfidenceScore is internal only: dampen pattern type if score < 40 (no new public fields).
 */
export function aggregateUnlockMetrics(
  mint: MintScannerResult,
  vesting: VestingDetectorResult,
  treasury: TreasuryTrackerResult,
  spike: TransferSpikeResult
): UnlockAggregatorOutput {
  const supplyVolatilityIndex = mint.inflationRate30d >= 0 && mint.inflationRate90d >= 0
    ? clamp(
        Math.abs(mint.inflationRate90d - mint.inflationRate30d) * 10,
        0,
        100
      )
    : 0;

  const dampenPattern = vesting.vestingConfidenceScore < 40 && (vesting.patternType === "linear" || vesting.patternType === "cliff");
  const unlockPatternType = dampenPattern ? "unknown" : vesting.patternType;

  return {
    unlockPressureRatio: spike.unlockPressureRatio,
    cliffDetected: vesting.cliffDetected,
    unlockPatternType,
    emissionAccelerationScore: clamp(mint.emissionAccelerationScore, 0, 100),
    supplyVolatilityIndex: Math.round(supplyVolatilityIndex),
  };
}
