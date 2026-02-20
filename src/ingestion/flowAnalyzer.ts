import type { ExchangeRegistry } from "../core/types.js";
import type { UnlockFlow } from "../core/types.js";
import { query } from "../infrastructure/database/postgres.js";

const INSERT_FLOW_SQL = `
INSERT INTO unlock_flow_analysis (
  token_symbol, unlock_event_id, transferred_to_exchange, exchange_label,
  retained_in_wallet, moved_to_new_wallet, risk_flag, high_velocity, suspected_hot_wallet,
  cluster_tag, velocity_score, cluster_concentration_ratio, routed_to_exchange, chain_id, analyzed_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
`;

const UPSERT_CLUSTER_FLOW_SQL = `
INSERT INTO cluster_flow_aggregation (
  cluster_tag, token_symbol, chain_id, total_inflow, total_outflow, first_seen_block, last_seen_block, last_updated
) VALUES ($1, $2, $3, $4, 0, $5, $6, NOW())
ON CONFLICT (cluster_tag, token_symbol, chain_id)
DO UPDATE SET
  total_inflow = cluster_flow_aggregation.total_inflow + EXCLUDED.total_inflow,
  last_seen_block = GREATEST(COALESCE(cluster_flow_aggregation.last_seen_block, 0), EXCLUDED.last_seen_block),
  first_seen_block = LEAST(COALESCE(cluster_flow_aggregation.first_seen_block, 9223372036854775807), EXCLUDED.first_seen_block),
  last_updated = NOW()
`;

const CLUSTER_SUSPECTED_HOT_WALLET = "suspected_exchange_hot_wallet";
const VELOCITY_BLOCK_WINDOW = 6;
const VELOCITY_TIME_MS = 10 * 60 * 1000;
const ROUTED_WINDOW_MS = 24 * 60 * 60 * 1000;
const CONCENTRATION_HIGH_THRESHOLD = 0.6;

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export interface UnlockEventForFlow {
  id: string;
  token_symbol: string;
  event_type: string;
  amount: string;
  recipient_address: string | null;
  block_number?: string;
  timestamp?: Date;
  chain_id?: string;
}

interface EventFlowRow {
  id: string;
  block_number: string | null;
  timestamp: Date | null;
  transferred_to_exchange: boolean;
  moved_to_new_wallet: boolean;
}

async function getTotalClaimedForToken(tokenSymbol: string, chainId: string): Promise<number> {
  const r = await query<{ sum: string }>(
    `SELECT COALESCE(SUM(amount::numeric), 0) AS sum FROM unlock_events WHERE token_symbol = $1 AND chain_id = $2`,
    [tokenSymbol, chainId]
  );
  return parseFloat(r.rows[0]?.sum ?? "0") || 0;
}

async function getEventFlowsForToken(tokenSymbol: string, chainId: string): Promise<EventFlowRow[]> {
  const result = await query<{
    id: string;
    block_number: string | null;
    timestamp: Date | null;
    transferred_to_exchange: boolean;
    moved_to_new_wallet: boolean;
  }>(
    `SELECT ue.id, ue.block_number::TEXT, ue.timestamp,
            COALESCE(ufa.transferred_to_exchange, FALSE) AS transferred_to_exchange,
            COALESCE(ufa.moved_to_new_wallet, FALSE) AS moved_to_new_wallet
     FROM unlock_events ue
     LEFT JOIN unlock_flow_analysis ufa ON ufa.unlock_event_id = ue.id AND ufa.chain_id = ue.chain_id
     WHERE ue.token_symbol = $1 AND ue.chain_id = $2`,
    [tokenSymbol, chainId]
  );
  return result.rows.map((r) => ({
    id: r.id,
    block_number: r.block_number,
    timestamp: r.timestamp,
    transferred_to_exchange: r.transferred_to_exchange,
    moved_to_new_wallet: r.moved_to_new_wallet,
  }));
}

async function getInflowToClusterForToken(
  tokenSymbol: string,
  clusterTag: string,
  chainId: string
): Promise<number> {
  const r = await query<{ sum: string }>(
    `SELECT COALESCE(SUM(ue.amount::numeric), 0) AS sum
     FROM unlock_events ue
     JOIN unlock_flow_analysis ufa ON ufa.unlock_event_id = ue.id AND ufa.chain_id = ue.chain_id
     WHERE ue.token_symbol = $1 AND ufa.cluster_tag = $2 AND ue.chain_id = $3`,
    [tokenSymbol, clusterTag, chainId]
  );
  return parseFloat(r.rows[0]?.sum ?? "0") || 0;
}

/**
 * Cluster-level flow analysis: clusterTag, velocity (2+ to exchange in 6 blocks or 10 min),
 * concentration ratio, routed_to_exchange, and updated risk (HIGH/MODERATE/none).
 */
export async function analyzeUnlockFlow(
  event: UnlockEventForFlow,
  exchangeRegistry: ExchangeRegistry
): Promise<UnlockFlow> {
  const recipient = event.recipient_address ?? "";
  const info = recipient ? exchangeRegistry.getExchangeInfo(recipient) : { isExchange: false };
  const isExchange = info.isExchange;
  const exchangeLabel = info.exchangeLabel ?? null;
  const clusterTag = info.clusterTag ?? null;
  const suspectedHotWallet = info.clusterTag === CLUSTER_SUSPECTED_HOT_WALLET;

  let transferredToExchange = false;
  let retainedInWallet = true;
  let movedToNewWallet = false;

  if (isExchange) {
    transferredToExchange = true;
    retainedInWallet = false;
  } else if (recipient && recipient.length > 0) {
    retainedInWallet = false;
    movedToNewWallet = true;
  }

  const amount = parseFloat(event.amount) || 0;
  const exchangeInflow = transferredToExchange ? amount : 0;
  const retainedAmount = retainedInWallet ? amount : 0;

  const chainId = event.chain_id ?? "ethereum";
  const currentBlock = event.block_number != null ? parseInt(event.block_number, 10) : null;
  const currentTime = event.timestamp != null ? event.timestamp.getTime() : null;

  const [totalClaimed, existingFlows] = await Promise.all([
    getTotalClaimedForToken(event.token_symbol, chainId),
    getEventFlowsForToken(event.token_symbol, chainId),
  ]);

  const otherFlows = existingFlows.filter((f) => f.id !== event.id);

  let velocityScore = 0;
  const countToExchangeInWindow =
    (transferredToExchange ? 1 : 0) +
    otherFlows.filter((f) => {
      if (!f.transferred_to_exchange) return false;
      const block = f.block_number != null ? parseInt(f.block_number, 10) : null;
      const time = f.timestamp != null ? f.timestamp.getTime() : null;
      if (currentBlock != null && block != null && Math.abs(block - currentBlock) <= VELOCITY_BLOCK_WINDOW)
        return true;
      if (currentTime != null && time != null && Math.abs(time - currentTime) <= VELOCITY_TIME_MS) return true;
      return false;
    }).length;
  if (countToExchangeInWindow >= 2) velocityScore = 1;
  else if (countToExchangeInWindow === 1) velocityScore = 0.5;
  const highVelocity = velocityScore >= 0.5 || transferredToExchange;

  const inflowToCluster =
    clusterTag != null && transferredToExchange
      ? (await getInflowToClusterForToken(event.token_symbol, clusterTag, chainId)) + amount
      : clusterTag != null
        ? await getInflowToClusterForToken(event.token_symbol, clusterTag, chainId)
        : 0;
  const clusterConcentrationRatio =
    totalClaimed > 0 && clusterTag != null ? inflowToCluster / totalClaimed : null;
  const highConcentration = clusterConcentrationRatio != null && clusterConcentrationRatio > CONCENTRATION_HIGH_THRESHOLD;

  const hasExchangeFlowIn24h =
    currentTime != null &&
    otherFlows.some((f) => {
      if (!f.transferred_to_exchange) return false;
      const time = f.timestamp != null ? f.timestamp.getTime() : null;
      return time != null && Math.abs(time - currentTime) <= ROUTED_WINDOW_MS;
    });
  const routedToExchange = movedToNewWallet && hasExchangeFlowIn24h;

  let riskFlag: UnlockFlow["risk_flag"] = "none";
  if (transferredToExchange || highConcentration) riskFlag = "high";
  else if (suspectedHotWallet || routedToExchange) riskFlag = "moderate";
  else if (retainedInWallet) riskFlag = "none";
  else riskFlag = "moderate";

  await query(INSERT_FLOW_SQL, [
    event.token_symbol,
    event.id,
    transferredToExchange,
    exchangeLabel,
    retainedInWallet,
    movedToNewWallet,
    riskFlag,
    highVelocity,
    suspectedHotWallet,
    clusterTag,
    velocityScore,
    clusterConcentrationRatio,
    routedToExchange,
    chainId,
  ]);

  if (clusterTag != null && transferredToExchange && currentBlock != null) {
    await query(UPSERT_CLUSTER_FLOW_SQL, [
      clusterTag,
      event.token_symbol,
      chainId,
      amount,
      currentBlock,
      currentBlock,
    ]);
  }

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
    high_velocity: highVelocity,
    suspected_hot_wallet: suspectedHotWallet,
    cluster_tag: clusterTag,
    velocity_score: velocityScore,
    cluster_concentration_ratio: clusterConcentrationRatio,
    routed_to_exchange: routedToExchange,
    chain_id: chainId,
  };
}

/**
 * Cluster events by 24h window (bucket timestamp). Used for time-based aggregation.
 */
export function getTimeWindowBucket(timestamp: Date): number {
  return Math.floor(timestamp.getTime() / TWENTY_FOUR_HOURS_MS) * TWENTY_FOUR_HOURS_MS;
}
