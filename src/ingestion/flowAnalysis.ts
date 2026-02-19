/**
 * Layer 3 — Sellable Supply Detection.
 * Distinguishes scheduled unlock vs actually sellable (e.g. transferred to exchanges).
 */

import { query } from "../db.js";
import { isKnownExchangeAddress, getExchangeLabel } from "./exchangeAddresses.js";
import type { FlowRiskFlag } from "./types.js";

const INSERT_FLOW_SQL = `
INSERT INTO unlock_flow_analysis (
  token_symbol, unlock_event_id, transferred_to_exchange, exchange_label,
  retained_in_wallet, moved_to_new_wallet, risk_flag, analyzed_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
`;

export interface UnlockEventForFlow {
  id: string;
  token_symbol: string;
  event_type: string;
  amount: string;
  recipient_address: string | null;
}

/**
 * Analyze a single unlock event: exchange transfer → high risk;
 * retained in wallet → low risk; moved to new wallet (future: multi-hop) → moderate.
 */
export async function analyzeUnlockFlow(
  event: UnlockEventForFlow
): Promise<void> {
  const recipient = event.recipient_address ?? "";
  const isExchange = recipient ? isKnownExchangeAddress(recipient) : false;
  const exchangeLabel = isExchange ? getExchangeLabel(recipient) : null;

  let transferredToExchange = false;
  let retainedInWallet = true;
  let movedToNewWallet = false;
  let riskFlag: FlowRiskFlag = "none";

  if (isExchange) {
    transferredToExchange = true;
    retainedInWallet = false;
    riskFlag = "high";
  } else if (recipient && recipient.length > 0) {
    retainedInWallet = false;
    movedToNewWallet = true;
    riskFlag = "moderate";
  }

  await query(INSERT_FLOW_SQL, [
    event.token_symbol,
    event.id,
    transferredToExchange,
    exchangeLabel,
    retainedInWallet,
    movedToNewWallet,
    riskFlag,
  ]);
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Real sellable supply: from recent unlock_events, subtract retained, add exchange-bound.
 * Feeds into computeImpactScore and unlock_analysis.
 */
export async function computeRealSellableSupply(tokenSymbol: string): Promise<{
  token_symbol: string;
  scheduled_unlock_amount: number;
  claimed_amount: number;
  sellable_amount: number;
  percent_sellable: number;
}> {
  const since = new Date(Date.now() - THIRTY_DAYS_MS);

  const eventsResult = await query<{
    id: string;
    amount: string;
  }>(
    `SELECT id, amount FROM unlock_events
     WHERE token_symbol = $1 AND timestamp >= $2`,
    [tokenSymbol, since]
  );

  let totalClaimed = 0;
  let totalSellable = 0;

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
    } else if (!flow?.retained_in_wallet && flow) {
      totalSellable += amount;
    }
  }

  const scheduledUnlockAmount = totalClaimed;
  const sellableAmount = totalSellable;
  const percentSellable =
    scheduledUnlockAmount > 0
      ? (sellableAmount / scheduledUnlockAmount) * 100
      : 0;

  return {
    token_symbol: tokenSymbol,
    scheduled_unlock_amount: scheduledUnlockAmount,
    claimed_amount: totalClaimed,
    sellable_amount: sellableAmount,
    percent_sellable: percentSellable,
  };
}
