/**
 * Unlock Risk Model — simplified, non-contradictory scoring.
 * Inputs: unlock_percent_of_circulating, unlock_amount, avg_daily_volume, next_unlock_timestamp.
 * Outputs: event_severity_label, absorption_risk_label, timing_urgency_label, composite_score, final_risk_tier.
 */

export type EventSeverityLabel = "MINIMAL" | "LOW" | "ELEVATED" | "HIGH" | "EXTREME";
export type AbsorptionRiskLabel = "LOW" | "MODERATE" | "HIGH" | "CRITICAL";
export type TimingUrgencyLabel = "DISTANT" | "MODERATE" | "NEAR" | "IMMINENT";
export type FinalRiskTier = "MINOR" | "ELEVATED" | "HIGH" | "CRITICAL";

export interface UnlockRiskModelInput {
  /** Unlock as fraction of circulating supply (0–1). */
  unlock_percent_of_circulating: number;
  /** Unlock amount in USD. */
  unlock_amount: number;
  /** Average daily trading volume in USD (30d / 30). */
  avg_daily_volume: number;
  /** Unix timestamp of next unlock; null if none. */
  next_unlock_timestamp: number | null;
}

export interface UnlockRiskModelOutput {
  event_severity_label: EventSeverityLabel;
  absorption_risk_label: AbsorptionRiskLabel;
  timing_urgency_label: TimingUrgencyLabel;
  composite_score: number;
  final_risk_tier: FinalRiskTier;
  /** Days of volume = unlock_amount / avg_daily_volume. */
  days_of_volume: number;
  /** Days until next unlock. */
  days_until_unlock: number | null;
}

/** Severity score 1–5 from unlock_percent_of_circulating. */
function severityScore(pct: number): number {
  if (pct >= 0.3) return 5;
  if (pct >= 0.15) return 4;
  if (pct >= 0.05) return 3;
  if (pct >= 0.02) return 2;
  return 1;
}

/** Severity label from score. */
function severityLabel(score: number): EventSeverityLabel {
  if (score >= 5) return "EXTREME";
  if (score >= 4) return "HIGH";
  if (score >= 3) return "ELEVATED";
  if (score >= 2) return "LOW";
  return "MINIMAL";
}

/** Absorption score 1–4 from days_of_volume. */
function absorptionScore(daysOfVolume: number): number {
  if (daysOfVolume >= 7) return 4;
  if (daysOfVolume >= 3) return 3;
  if (daysOfVolume >= 1) return 2;
  return 1;
}

/** Absorption label from score. */
function absorptionLabel(score: number): AbsorptionRiskLabel {
  if (score >= 4) return "CRITICAL";
  if (score >= 3) return "HIGH";
  if (score >= 2) return "MODERATE";
  return "LOW";
}

/** Timing score 1–4 from days_until_unlock. */
function timingScore(daysUntilUnlock: number | null): number {
  if (daysUntilUnlock == null) return 1;
  if (daysUntilUnlock > 60) return 1;
  if (daysUntilUnlock >= 30) return 2;
  if (daysUntilUnlock >= 7) return 3;
  return 4;
}

/** Timing label from score. */
function timingLabel(score: number): TimingUrgencyLabel {
  if (score >= 4) return "IMMINENT";
  if (score >= 3) return "NEAR";
  if (score >= 2) return "MODERATE";
  return "DISTANT";
}

/** Final tier from composite score. */
function finalTier(composite: number): FinalRiskTier {
  if (composite >= 3.5) return "CRITICAL";
  if (composite >= 2.5) return "HIGH";
  if (composite >= 1.5) return "ELEVATED";
  return "MINOR";
}

/**
 * Compute unlock risk from inputs.
 * composite = (severity * 0.5) + (absorption * 0.3) + (timing * 0.2)
 */
export function computeUnlockRisk(input: UnlockRiskModelInput): UnlockRiskModelOutput {
  const now = Math.floor(Date.now() / 1000);
  const pct = Math.max(0, Math.min(1, input.unlock_percent_of_circulating));
  const avgDaily = input.avg_daily_volume > 0 ? input.avg_daily_volume : 1;
  const daysOfVolume = input.unlock_amount / avgDaily;
  const daysUntilUnlock =
    input.next_unlock_timestamp != null
      ? Math.max(0, Math.ceil((input.next_unlock_timestamp - now) / 86400))
      : null;

  const sev = severityScore(pct);
  const abs = absorptionScore(daysOfVolume);
  const tim = timingScore(daysUntilUnlock);

  const composite = sev * 0.5 + abs * 0.3 + tim * 0.2;

  return {
    event_severity_label: severityLabel(sev),
    absorption_risk_label: absorptionLabel(abs),
    timing_urgency_label: timingLabel(tim),
    composite_score: Math.round(composite * 100) / 100,
    final_risk_tier: finalTier(composite),
    days_of_volume: Math.round(daysOfVolume * 100) / 100,
    days_until_unlock: daysUntilUnlock,
  };
}
