import { query } from "../infrastructure/database/postgres.js";
import type { IntelligenceReport } from "../core/types.js";
import { getVestingAnalysisByToken } from "../ingestion/vestingAnalysis.js";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export interface SellableSupplyResult {
  scheduled_amount: number;
  claimed_amount: number;
  retained_amount: number;
  exchange_inflow: number;
  high_velocity_transfers: number;
  real_sellable_supply: number;
  liquidity_ratio: number;
  exchange_flow_ratio: number;
  /** From vesting_analysis: expected vested by now (refines unlock_percent) */
  expected_vested?: number;
  /** From vesting_analysis: remaining locked in contract */
  remaining_locked?: number;
  /** 24h unlock forecast (next_unlock_estimate); used for predictive impact when linear */
  expected_vested_24h?: number;
  /** Vesting type for predictive scoring (linear_vesting | openzeppelin_token_vesting | …) */
  vesting_type?: string | null;
}

export async function computeSellableSupply(
  tokenSymbol: string,
  avg30dVolumeUsd?: number,
  chainId?: string
): Promise<SellableSupplyResult> {
  const since = new Date(Date.now() - THIRTY_DAYS_MS);

  const eventsResult = await query<{ id: string; amount: string }>(
    chainId
      ? `SELECT id, amount FROM unlock_events
         WHERE token_symbol = $1 AND chain_id = $2 AND timestamp >= $3`
      : `SELECT id, amount FROM unlock_events
         WHERE token_symbol = $1 AND timestamp >= $2`,
    chainId ? [tokenSymbol, chainId, since] : [tokenSymbol, since]
  );

  let totalClaimed = 0;
  let totalRetained = 0;
  let totalExchangeInflow = 0;
  let totalHighVelocity = 0;

  for (const row of eventsResult.rows) {
    const amount = parseFloat(row.amount) || 0;
    totalClaimed += amount;

    const flowResult = await query<{
      transferred_to_exchange: boolean;
      retained_in_wallet: boolean;
      moved_to_new_wallet: boolean;
    }>(
      `SELECT transferred_to_exchange, retained_in_wallet, moved_to_new_wallet
       FROM unlock_flow_analysis WHERE unlock_event_id = $1 LIMIT 1`,
      [row.id]
    );

    const flow = flowResult.rows[0];
    if (flow?.transferred_to_exchange) {
      totalExchangeInflow += amount;
    } else if (flow?.retained_in_wallet) {
      totalRetained += amount;
    } else if (flow?.moved_to_new_wallet) {
      totalHighVelocity += amount;
    }
  }

  const real_sellable_supply = totalExchangeInflow + totalHighVelocity;
  const exchange_flow_ratio =
    totalClaimed > 0 ? totalExchangeInflow / totalClaimed : 0;
  const liquidity_ratio =
    avg30dVolumeUsd != null && avg30dVolumeUsd > 0
      ? real_sellable_supply / avg30dVolumeUsd
      : 0;

  const vesting = await getVestingAnalysisByToken(tokenSymbol, chainId);

  return {
    scheduled_amount: totalClaimed,
    claimed_amount: totalClaimed,
    retained_amount: totalRetained,
    exchange_inflow: totalExchangeInflow,
    high_velocity_transfers: totalHighVelocity,
    real_sellable_supply,
    liquidity_ratio,
    exchange_flow_ratio,
    ...(vesting
      ? {
          expected_vested: vesting.expected_vested,
          remaining_locked: vesting.remaining_locked,
          expected_vested_24h: vesting.next_unlock_estimate ?? undefined,
          vesting_type: vesting.vesting_type,
        }
      : {}),
  };
}

/** Liquidity normalization: real_sellable_supply / avg_30d_volume. */
export function liquidityRatio(realSellableSupply: number, avg30dVolumeUsd: number): number {
  if (!avg30dVolumeUsd || avg30dVolumeUsd <= 0) return 0;
  return realSellableSupply / avg30dVolumeUsd;
}

/** Normalized impact factor (0–1 scale) from liquidity ratio. */
export function normalizedImpactFactor(liquidityRatioValue: number): number {
  if (liquidityRatioValue <= 0) return 0;
  return Math.min(1, Math.log1p(liquidityRatioValue) / Math.log1p(10));
}

export function toReportSellableSupply(supply: SellableSupplyResult): IntelligenceReport["sellable_supply"] {
  return {
    scheduled_amount: supply.scheduled_amount,
    claimed_amount: supply.claimed_amount,
    retained_amount: supply.retained_amount,
    exchange_inflow: supply.exchange_inflow,
    real_sellable_supply: supply.real_sellable_supply,
  };
}
