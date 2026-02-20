import type { ExchangeRegistry } from "../core/types.js";
import type { UnlockFlow } from "../core/types.js";
import { query } from "../infrastructure/database/postgres.js";

const INSERT_FLOW_SQL = `
INSERT INTO unlock_flow_analysis (
  token_symbol, unlock_event_id, transferred_to_exchange, exchange_label,
  retained_in_wallet, moved_to_new_wallet, risk_flag, analyzed_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
`;

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export interface UnlockEventForFlow {
  id: string;
  token_symbol: string;
  event_type: string;
  amount: string;
  recipient_address: string | null;
}

/**
 * Analyze a single unlock event: exchange transfer → high risk;
 * retained in wallet → low risk; moved to new wallet → moderate (basic multi-hop detection).
 * Time-based clustering uses 24h window for grouping.
 */
export async function analyzeUnlockFlow(
  event: UnlockEventForFlow,
  exchangeRegistry: ExchangeRegistry
): Promise<UnlockFlow> {
  const recipient = event.recipient_address ?? "";
  const isExchange = recipient ? exchangeRegistry.isKnownExchangeAddress(recipient) : false;
  const exchangeLabel = isExchange ? exchangeRegistry.getExchangeLabel(recipient) : null;

  let transferredToExchange = false;
  let retainedInWallet = true;
  let movedToNewWallet = false;
  let riskFlag: UnlockFlow["risk_flag"] = "none";

  if (isExchange) {
    transferredToExchange = true;
    retainedInWallet = false;
    riskFlag = "high";
  } else if (recipient && recipient.length > 0) {
    retainedInWallet = false;
    movedToNewWallet = true;
    riskFlag = "moderate";
  }

  const amount = parseFloat(event.amount) || 0;
  const exchangeInflow = transferredToExchange ? amount : 0;
  const retainedAmount = retainedInWallet ? amount : 0;

  await query(INSERT_FLOW_SQL, [
    event.token_symbol,
    event.id,
    transferredToExchange,
    exchangeLabel,
    retainedInWallet,
    movedToNewWallet,
    riskFlag,
  ]);

  return {
    token_symbol: event.token_symbol,
    unlock_event_id: event.id,
    transferred_to_exchange: transferredToExchange,
    exchange_label: exchangeLabel,
    retained_in_wallet: retainedInWallet,
    moved_to_new_wallet: movedToNewWallet,
    risk_flag: riskFlag,
    exchange_inflow: exchangeInflow,
    retained_amount: retainedAmount,
    analyzed_at: new Date(),
  };
}

/**
 * Cluster events by 24h window (bucket timestamp). Used for time-based aggregation.
 */
export function getTimeWindowBucket(timestamp: Date): number {
  return Math.floor(timestamp.getTime() / TWENTY_FOUR_HOURS_MS) * TWENTY_FOUR_HOURS_MS;
}
