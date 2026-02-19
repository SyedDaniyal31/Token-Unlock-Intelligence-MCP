/**
 * MCP broker / protocol handling.
 * Placeholder for @modelcontextprotocol/sdk integration.
 */

export interface ImpactScoreInput {
  unlock_percent_supply: number | null;
  unlock_vs_volume_ratio: number | null;
  historical_avg_7d_return: number | null;
  cohort_type: string | null;
}

export type ImpactScoreLevel = "Low" | "Medium" | "High";

export interface ImpactScoreResult {
  impact_score: ImpactScoreLevel;
  risk_summary: string;
}

/**
 * Compute impact score and risk summary from unlock metrics.
 * High/Medium thresholds applied first; remainder is Low.
 */
export function computeImpactScore(input: ImpactScoreInput): ImpactScoreResult {
  const {
    unlock_percent_supply = null,
    unlock_vs_volume_ratio = null,
    historical_avg_7d_return = null,
    cohort_type = null,
  } = input;

  const ratio = unlock_vs_volume_ratio ?? -1;
  const pctSupply = unlock_percent_supply ?? -1;
  const avgReturn = historical_avg_7d_return ?? 0;

  let impact_score: ImpactScoreLevel;
  let risk_summary: string;

  // High risk
  if (ratio > 0.5 || pctSupply > 5 || avgReturn < -5) {
    impact_score = "High";
    const reasons: string[] = [];
    if (ratio > 0.5) {
      reasons.push(
        `Unlock is >50% of 30d volume (${(ratio * 100).toFixed(1)}%)—selling can overwhelm buy support.`
      );
    }
    if (pctSupply > 5) {
      reasons.push(
        `Large supply unlock (${pctSupply.toFixed(1)}% of circulating supply)—expect elevated sell pressure.`
      );
    }
    if (avgReturn < -5) {
      reasons.push(
        `Token down >5% in past 7 days (${avgReturn.toFixed(1)}%)—momentum is negative into unlock.`
      );
    }
    risk_summary =
      `High unlock risk. ${reasons.join(" ")} Action: Reduce size or hedge; consider waiting for post-unlock stabilization before adding.`;
  }
  // Medium risk
  else if (
    (ratio >= 0.2 && ratio <= 0.5) ||
    (pctSupply >= 2 && pctSupply <= 5)
  ) {
    impact_score = "Medium";
    const reasons: string[] = [];
    if (ratio >= 0.2 && ratio <= 0.5) {
      reasons.push(
        `Unlock is 20–50% of 30d volume (${(ratio * 100).toFixed(1)}%)—moderate dilution risk.`
      );
    }
    if (pctSupply >= 2 && pctSupply <= 5) {
      reasons.push(
        `Unlock size ${pctSupply.toFixed(1)}% of supply—watch for distribution.`
      );
    }
    const cohortNote =
      cohort_type && cohort_type.length > 0
        ? ` Cohort: ${cohort_type}.`
        : "";
    risk_summary =
      `Moderate unlock risk. ${reasons.join(" ")}${cohortNote} Action: Size positions cautiously; set stops and watch volume and order book around unlock date.`;
  }
  // Low risk
  else {
    impact_score = "Low";
    const cohortNote =
      cohort_type && cohort_type.length > 0
        ? ` (${cohort_type} unlock).`
        : "";
    risk_summary =
      `Low unlock risk. Unlock is small vs volume and supply.${cohortNote} Action: Standard position sizing; monitor for any change in volume or sentiment ahead of unlock.`;
  }

  return { impact_score, risk_summary };
}

export function createBroker(): { shutdown: () => Promise<void> } {
  return {
    async shutdown(): Promise<void> {
      // Cleanup MCP resources
    },
  };
}
