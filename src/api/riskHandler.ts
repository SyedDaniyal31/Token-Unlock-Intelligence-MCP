/**
 * Risk route handler: validates token and returns structured risk metrics.
 * No business logic here — delegates to intelligence pipeline and maps response.
 */

import type { IntelligenceReport } from "../core/types.js";
import type { UnlockIntelligenceDeps } from "../intelligence/unlockIntelligence.js";
import { getIntelligenceReport } from "./mcpController.js";

export interface RiskRouteResponse {
  unlock_pressure_ratio: number;
  volume_impact_ratio: number;
  supply_inflation_percent: number;
  risk_score: number;
  risk_level: string;
}

function mapReportToRiskResponse(report: IntelligenceReport): RiskRouteResponse {
  const volumeRatio =
    report.liquidityStress?.unlockToVolumeRatio ?? report.unlock_vs_volume_ratio;
  const supplyPct =
    report.liquidityStress?.unlockToSupplyPct ?? report.unlock_percent_supply;

  return {
    unlock_pressure_ratio: volumeRatio,
    volume_impact_ratio: volumeRatio,
    supply_inflation_percent: supplyPct,
    risk_score: report.score_numeric,
    risk_level: report.risk_level,
  };
}

/**
 * Shared risk handler: validate token via registry, run intelligence pipeline, return risk metrics.
 * Call from both GET and POST /risk. Throws if token invalid (caller returns 400).
 */
export async function handleRisk(
  token: string,
  deps: UnlockIntelligenceDeps
): Promise<RiskRouteResponse> {
  const report = await getIntelligenceReport(token, deps);
  return mapReportToRiskResponse(report);
}
