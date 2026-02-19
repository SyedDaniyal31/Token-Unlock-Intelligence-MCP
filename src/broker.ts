/**
 * Unlock precompute pipeline: load data → computeImpactScore → upsert to PostgreSQL.
 * Premium ingestion (3-layer) is in ./ingestion. Background only; no API routes. Safe for cron.
 */

import { query } from "./db.js";
import { runUnlockIngestionPipeline } from "./ingestion/index.js";
import {
  computeImpactScore,
  type ImpactOutput,
  type ImpactInput,
} from "./impactEngine.js";
import logger from "./logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MarketRegime = "bull" | "neutral" | "bear";

export type CohortType =
  | "vc"
  | "team"
  | "foundation"
  | "ecosystem"
  | "airdrop"
  | "strategic";

export interface UnlockRawInput {
  token_symbol: string;
  unlock_percent_circulating: number;
  unlock_percent_free_float: number;
  unlock_usd_value: number;
  avg_30d_volume_usd: number;
  cohort_type: CohortType;
  avg_7d_return_post_unlock: number;
  token_performance_since_tge: number;
  market_regime: MarketRegime;
  next_unlock_date: Date;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeDivide(a: number, b: number): number {
  if (!b || b === 0) return 0;
  return a / b;
}

function toImpactInput(raw: UnlockRawInput): ImpactInput {
  return {
    unlock_percent_circulating: raw.unlock_percent_circulating,
    unlock_percent_free_float: raw.unlock_percent_free_float,
    unlock_usd_value: raw.unlock_usd_value,
    avg_30d_volume_usd: raw.avg_30d_volume_usd,
    cohort_type: raw.cohort_type,
    avg_7d_return_post_unlock: raw.avg_7d_return_post_unlock,
    token_performance_since_tge: raw.token_performance_since_tge,
    market_regime: raw.market_regime,
  };
}

// ---------------------------------------------------------------------------
// Data loader (Phase 1: mock)
// ---------------------------------------------------------------------------

async function loadUnlockData(): Promise<UnlockRawInput[]> {
  const now = new Date();
  const in30d = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const in45d = new Date(now.getTime() + 45 * 24 * 60 * 60 * 1000);
  const in60d = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);

  return [
    {
      token_symbol: "ARB",
      unlock_percent_circulating: 4.5,
      unlock_percent_free_float: 6,
      unlock_usd_value: 120_000_000,
      avg_30d_volume_usd: 250_000_000,
      cohort_type: "vc",
      avg_7d_return_post_unlock: -3,
      token_performance_since_tge: 80,
      market_regime: "neutral",
      next_unlock_date: in30d,
    },
    {
      token_symbol: "OP",
      unlock_percent_circulating: 2,
      unlock_percent_free_float: 3,
      unlock_usd_value: 25_000_000,
      avg_30d_volume_usd: 180_000_000,
      cohort_type: "ecosystem",
      avg_7d_return_post_unlock: 2,
      token_performance_since_tge: 150,
      market_regime: "neutral",
      next_unlock_date: in45d,
    },
    {
      token_symbol: "APT",
      unlock_percent_circulating: 8,
      unlock_percent_free_float: 11,
      unlock_usd_value: 280_000_000,
      avg_30d_volume_usd: 350_000_000,
      cohort_type: "team",
      avg_7d_return_post_unlock: -9,
      token_performance_since_tge: -30,
      market_regime: "bear",
      next_unlock_date: in60d,
    },
  ];
}

// ---------------------------------------------------------------------------
// Upsert (requires UNIQUE(token_symbol) on unlock_analysis)
// ---------------------------------------------------------------------------

const UPSERT_SQL = `
INSERT INTO unlock_analysis (
  token_symbol,
  next_unlock_date,
  unlock_amount,
  unlock_percent_supply,
  avg_30d_volume_usd,
  unlock_vs_volume_ratio,
  cohort_type,
  historical_avg_7d_return,
  impact_score,
  risk_summary,
  updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
ON CONFLICT (token_symbol)
DO UPDATE SET
  next_unlock_date = EXCLUDED.next_unlock_date,
  unlock_amount = EXCLUDED.unlock_amount,
  unlock_percent_supply = EXCLUDED.unlock_percent_supply,
  avg_30d_volume_usd = EXCLUDED.avg_30d_volume_usd,
  unlock_vs_volume_ratio = EXCLUDED.unlock_vs_volume_ratio,
  cohort_type = EXCLUDED.cohort_type,
  historical_avg_7d_return = EXCLUDED.historical_avg_7d_return,
  impact_score = EXCLUDED.impact_score,
  risk_summary = EXCLUDED.risk_summary,
  updated_at = EXCLUDED.updated_at
`;

async function upsertUnlockAnalysis(
  token: UnlockRawInput,
  impact: ImpactOutput
): Promise<void> {
  const unlockVsVolumeRatio = safeDivide(
    token.unlock_usd_value,
    token.avg_30d_volume_usd
  );
  const impactScore = impact.risk_level.toLowerCase();
  const updatedAt = new Date();

  await query(UPSERT_SQL, [
    token.token_symbol,
    token.next_unlock_date,
    token.unlock_usd_value,
    token.unlock_percent_circulating,
    token.avg_30d_volume_usd,
    unlockVsVolumeRatio,
    token.cohort_type,
    token.avg_7d_return_post_unlock,
    impactScore,
    impact.risk_summary,
    updatedAt,
  ]);
}

// ---------------------------------------------------------------------------
// Precompute runner
// ---------------------------------------------------------------------------

export async function runUnlockPrecompute(): Promise<void> {
  const unlocks = await loadUnlockData();

  for (const raw of unlocks) {
    try {
      const input = toImpactInput(raw);
      const impact = computeImpactScore(input);
      await upsertUnlockAnalysis(raw, impact);
      logger.info({
        token_symbol: raw.token_symbol,
        final_score: impact.final_score,
        risk_level: impact.risk_level,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ token_symbol: raw.token_symbol, error: message });
    }
  }
}

// ---------------------------------------------------------------------------
// Startup hook
// ---------------------------------------------------------------------------

export async function initializeUnlockEngine(): Promise<void> {
  try {
    await runUnlockIngestionPipeline();
    await runUnlockPrecompute();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ scope: "initializeUnlockEngine", error: message });
  }
}

export { runUnlockIngestionPipeline };

// ---------------------------------------------------------------------------
// MCP broker (shutdown)
// ---------------------------------------------------------------------------

export function createBroker(): { shutdown: () => Promise<void> } {
  return {
    async shutdown(): Promise<void> {},
  };
}
