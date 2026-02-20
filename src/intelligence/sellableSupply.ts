import { query } from "../infrastructure/database/postgres.js";
import type { IntelligenceReport } from "../core/types.js";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export interface SellableSupplyResult {
  scheduled_amount: number;
  claimed_amount: number;
  retained_amount: number;
  exchange_inflow: number;
  real_sellable_supply: number;
}

export async function computeSellableSupply(tokenSymbol: string): Promise<SellableSupplyResult> {
  const since = new Date(Date.now() - THIRTY_DAYS_MS);

  const eventsResult = await query<{ id: string; amount: string }>(
    `SELECT id, amount FROM unlock_events
     WHERE token_symbol = $1 AND timestamp >= $2`,
    [tokenSymbol, since]
  );

  let totalClaimed = 0;
  let totalSellable = 0;
  let totalRetained = 0;
  let totalExchangeInflow = 0;

  for (const row of eventsResult.rows) {
    const amount = parseFloat(row.amount) || 0;
    totalClaimed += amount;

    const flowResult = await query<{
      transferred_to_exchange: boolean;
      retained_in_wallet: boolean;
    }>(
      `SELECT transferred_to_exchange, retained_in_wallet
       FROM unlock_flow_analysis WHERE unlock_event_id = $1 LIMIT 1`,
      [row.id]
    );

    const flow = flowResult.rows[0];
    if (flow?.transferred_to_exchange) {
      totalSellable += amount;
      totalExchangeInflow += amount;
    } else if (!flow?.retained_in_wallet && flow) {
      totalSellable += amount;
    } else if (flow?.retained_in_wallet) {
      totalRetained += amount;
    }
  }

  return {
    scheduled_amount: totalClaimed,
    claimed_amount: totalClaimed,
    retained_amount: totalRetained,
    exchange_inflow: totalExchangeInflow,
    real_sellable_supply: totalSellable,
  };
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
