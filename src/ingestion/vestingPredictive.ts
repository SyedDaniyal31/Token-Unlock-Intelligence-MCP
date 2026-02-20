/**
 * Predictive vesting: rate modeling, next unlock forecast, acceleration, density, confidence.
 * Used by unlockVerifier before upserting vesting_analysis.
 */

const SECONDS_PER_DAY = 86400;
const SECONDS_24H = 86400;
const ACCELERATION_THRESHOLD = 1.05;

export interface VestingPredictiveInput {
  total_allocation: number;
  claimed_amount: number;
  expected_vested: number;
  vesting_type: string | null;
  vesting_start: Date | null;
  vesting_end: Date | null;
  vesting_cliff: Date | null;
}

export interface VestingPredictiveResult {
  vesting_rate_per_second: number | null;
  next_unlock_estimate: number | null;
  accelerated_claim: boolean;
  unlock_density: number | null;
  vesting_confidence: number;
}

/**
 * Vesting rate per second for linear: total_allocation / (end - start).
 */
export function vestingRatePerSecond(
  totalAllocation: number,
  startTs: number | null,
  endTs: number | null
): number | null {
  if (totalAllocation <= 0 || endTs == null || endTs <= 0) return null;
  const start = startTs ?? 0;
  const duration = endTs - start;
  if (duration <= 0) return null;
  return totalAllocation / duration;
}

/**
 * Next unlock forecast:
 * - Linear: vesting_rate_per_second * 86400 (24h).
 * - Cliff in future: estimate cliff release size (linear portion up to cliff, or full cliff amount).
 * - Cliff past: linear from cliff forward (rate * 86400).
 */
export function nextUnlockForecast(
  totalAllocation: number,
  startTs: number | null,
  endTs: number | null,
  cliffTs: number | null,
  nowTs: number,
  ratePerSecond: number | null,
  vestingType: string | null
): number | null {
  if (totalAllocation <= 0 || endTs == null || endTs <= 0) return null;
  const start = startTs ?? 0;
  const duration = endTs - start;
  if (duration <= 0) return null;

  const isLinear =
    vestingType === "linear_vesting" ||
    vestingType === "openzeppelin_token_vesting";
  const isCliff = vestingType === "cliff_vesting" || (cliffTs != null && cliffTs > 0);

  if (isLinear && ratePerSecond != null && ratePerSecond > 0) {
    return ratePerSecond * SECONDS_24H;
  }

  if (isCliff && cliffTs != null && cliffTs > 0) {
    if (nowTs < cliffTs) {
      const cliffRelease = (totalAllocation * (cliffTs - start)) / duration;
      return Math.min(totalAllocation, cliffRelease);
    }
    if (ratePerSecond != null && ratePerSecond > 0) {
      return ratePerSecond * SECONDS_24H;
    }
  }

  if (ratePerSecond != null && ratePerSecond > 0) {
    return ratePerSecond * SECONDS_24H;
  }
  return null;
}

/**
 * Unlock density = claimed_amount / (end - start in days). Higher = higher sell risk.
 */
export function unlockDensity(
  claimedAmount: number,
  startTs: number | null,
  endTs: number | null
): number | null {
  if (endTs == null || endTs <= 0) return null;
  const start = startTs ?? 0;
  const durationSec = endTs - start;
  if (durationSec <= 0) return null;
  const durationDays = durationSec / SECONDS_PER_DAY;
  if (durationDays <= 0) return null;
  return claimedAmount / durationDays;
}

/**
 * Vesting confidence: 1.0 full linear params, 0.7 generic, 0.3 unknown.
 */
export function vestingConfidence(vestingType: string | null): number {
  if (vestingType === "linear_vesting" || vestingType === "openzeppelin_token_vesting") return 1;
  if (vestingType === "cliff_vesting" || vestingType === "generic_vesting") return 0.7;
  return 0.3;
}

/**
 * Accelerated claim: actual_claimed > expected_vested * 1.05.
 */
export function isAcceleratedClaim(claimedAmount: number, expectedVested: number): boolean {
  if (expectedVested <= 0) return false;
  return claimedAmount > expectedVested * ACCELERATION_THRESHOLD;
}

/**
 * All predictive metrics for a schedule (used before vesting_analysis upsert).
 */
export function computeVestingPredictive(input: VestingPredictiveInput): VestingPredictiveResult {
  const startTs = input.vesting_start ? Math.floor(input.vesting_start.getTime() / 1000) : null;
  const endTs = input.vesting_end ? Math.floor(input.vesting_end.getTime() / 1000) : null;
  const cliffTs = input.vesting_cliff ? Math.floor(input.vesting_cliff.getTime() / 1000) : null;
  const nowTs = Math.floor(Date.now() / 1000);

  const rate = vestingRatePerSecond(input.total_allocation, startTs, endTs);
  const nextEstimate = nextUnlockForecast(
    input.total_allocation,
    startTs,
    endTs,
    cliffTs,
    nowTs,
    rate,
    input.vesting_type
  );
  const accelerated = isAcceleratedClaim(input.claimed_amount, input.expected_vested);
  const density = unlockDensity(input.claimed_amount, startTs, endTs);
  const confidence = vestingConfidence(input.vesting_type);

  return {
    vesting_rate_per_second: rate,
    next_unlock_estimate: nextEstimate,
    accelerated_claim: accelerated,
    unlock_density: density,
    vesting_confidence: confidence,
  };
}
