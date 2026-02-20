import type { IntelligenceReport } from "../core/types.js";
import type { UnlockIntelligenceDeps } from "../intelligence/unlockIntelligence.js";
import { generateUnlockIntelligence } from "../intelligence/unlockIntelligence.js";

export async function getIntelligenceReport(
  tokenSymbol: string,
  deps: UnlockIntelligenceDeps
): Promise<IntelligenceReport> {
  return generateUnlockIntelligence(tokenSymbol, deps);
}

/**
 * Extract token symbol from a free-text query (e.g. "What is unlock for ARB?" -> "ARB").
 */
export function extractTokenFromQuery(query: string): string | null {
  if (!query || typeof query !== "string") return null;
  const trimmed = query.trim();
  const upperMatch = trimmed.match(/\b([A-Z]{2,6})\b/);
  if (upperMatch) return upperMatch[1];
  const words = trimmed.split(/\s+/).filter((w) => w.length >= 2 && w.length <= 6);
  const last = words[words.length - 1];
  return last ? last.toUpperCase() : null;
}

export function reportToLegacyShape(report: IntelligenceReport): {
  token_symbol: string;
  next_unlock_date: string;
  unlock_amount: number;
  unlock_percent_supply: number;
  unlock_vs_volume_ratio: number;
  cohort_type: string;
  historical_avg_7d_return: number;
  impact_score: string;
  risk_summary: string;
  fetchedAt: string;
} {
  return {
    token_symbol: report.token_symbol,
    next_unlock_date: report.next_unlock_date,
    unlock_amount: report.unlock_amount,
    unlock_percent_supply: report.unlock_percent_supply,
    unlock_vs_volume_ratio: report.unlock_vs_volume_ratio,
    cohort_type: report.cohort_type,
    historical_avg_7d_return: report.historical_avg_7d_return,
    impact_score: report.impact_score,
    risk_summary: report.risk_summary,
    fetchedAt: report.fetched_at,
  };
}
