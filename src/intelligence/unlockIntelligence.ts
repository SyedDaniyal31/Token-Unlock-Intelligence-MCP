import type {
  ChainProvider,
  MarketDataProvider,
  ExchangeRegistry,
  IntelligenceReport,
  RiskLevel,
  ChainReport,
} from "../core/types.js";
import { getScheduleByToken, getChainIdsForToken } from "../ingestion/unlockRegistry.js";
import { verifyUnlocksOnChain, getUnprocessedEvents, markEventProcessed } from "../ingestion/unlockVerifier.js";
import { analyzeUnlockFlow } from "../ingestion/flowAnalyzer.js";
import { computeSellableSupply, toReportSellableSupply } from "./sellableSupply.js";
import {
  computeImpactScore,
  buildScoringInput,
  type ScoringOutput,
} from "./impactScoring.js";
import logger from "../core/logger.js";

export interface UnlockIntelligenceDeps {
  chainProvider: ChainProvider;
  marketProvider: MarketDataProvider;
  exchangeRegistry: ExchangeRegistry;
}

function riskLevelToScoreString(risk: RiskLevel): string {
  return risk;
}

function emptyReport(symbol: string): IntelligenceReport {
  return {
    token_symbol: symbol,
    next_unlock_date: "",
    unlock_amount: 0,
    unlock_percent_supply: 0,
    unlock_vs_volume_ratio: 0,
    cohort_type: "ecosystem",
    historical_avg_7d_return: 0,
    impact_score: "low",
    risk_level: "low",
    risk_summary: "Partial report; one or more stages failed.",
    score_numeric: 0,
    explanation: "Partial report; one or more stages failed.",
    primary_driver: "unlock_percent_circulating",
    sell_pressure_estimate: "Low",
    sellable_supply: {
      scheduled_amount: 0,
      claimed_amount: 0,
      retained_amount: 0,
      exchange_inflow: 0,
      real_sellable_supply: 0,
    },
    fetched_at: new Date().toISOString(),
  };
}

export async function generateUnlockIntelligence(
  tokenSymbol: string,
  deps: UnlockIntelligenceDeps
): Promise<IntelligenceReport> {
  const symbol = tokenSymbol.trim().toUpperCase();
  let metadata: Awaited<ReturnType<typeof getScheduleByToken>> = null;

  try {
    metadata = await getScheduleByToken(symbol);
  } catch (err) {
    logger.warn({ err, stage: "fetch_schedule", token_symbol: symbol }, "Stage failed");
    return emptyReport(symbol);
  }

  try {
    await verifyUnlocksOnChain(deps.chainProvider);
  } catch (err) {
    logger.warn({ err, stage: "verify_unlocks", token_symbol: symbol }, "Stage failed");
  }

  let events: Awaited<ReturnType<typeof getUnprocessedEvents>> = [];
  try {
    events = await getUnprocessedEvents();
    const tokenEvents = events.filter((e) => e.token_symbol === symbol);
    for (const event of tokenEvents) {
      try {
        await analyzeUnlockFlow(
          {
            id: event.id,
            token_symbol: event.token_symbol,
            event_type: event.event_type,
            amount: event.amount,
            recipient_address: event.recipient_address,
            block_number: event.block_number ?? undefined,
            timestamp: event.timestamp ?? undefined,
            chain_id: event.chain_id ?? undefined,
          },
          deps.exchangeRegistry
        );
        await markEventProcessed(event.id);
      } catch (err) {
        logger.warn({ err, stage: "analyze_flow", event_id: event.id }, "Event flow failed");
      }
    }
  } catch (err) {
    logger.warn({ err, stage: "get_events", token_symbol: symbol }, "Stage failed");
  }

  let market: Awaited<ReturnType<MarketDataProvider["getMarketSnapshot"]>>;
  try {
    market = await deps.marketProvider.getMarketSnapshot(symbol);
  } catch (err) {
    logger.warn({ err, stage: "market_snapshot", token_symbol: symbol }, "Stage failed");
    market = {
      token_symbol: symbol,
      price_usd: 0,
      circulating_supply: 0,
      avg_30d_volume_usd: 0,
      market_cap_usd: 0,
      liquidity_depth_usd: 0,
      fetched_at: new Date().toISOString(),
    };
  }

  let supply: Awaited<ReturnType<typeof computeSellableSupply>>;
  try {
    supply = await computeSellableSupply(symbol, market.avg_30d_volume_usd ?? undefined);
  } catch (err) {
    logger.warn({ err, stage: "sellable_supply", token_symbol: symbol }, "Stage failed");
    supply = {
      scheduled_amount: 0,
      claimed_amount: 0,
      retained_amount: 0,
      exchange_inflow: 0,
      high_velocity_transfers: 0,
      real_sellable_supply: 0,
      liquidity_ratio: 0,
      exchange_flow_ratio: 0,
    };
  }

  const cohortType = metadata?.beneficiary_label ?? "ecosystem";
  let scoring: ScoringOutput;
  try {
    const scoringInput = buildScoringInput(symbol, market, supply, cohortType, 0, 0);
    scoring = computeImpactScore(scoringInput);
  } catch (err) {
    logger.warn({ err, stage: "scoring", token_symbol: symbol }, "Stage failed");
    scoring = {
      score: 0,
      risk_level: "low",
      explanation: "Scoring failed.",
      primary_driver: "unlock_percent_circulating",
      sell_pressure_estimate: "Low",
    };
  }

  const nextUnlock = metadata?.vesting_end ?? null;
  const unlockAmount = supply.claimed_amount;
  const percentSupply =
    supply.scheduled_amount > 0
      ? (supply.real_sellable_supply / supply.scheduled_amount) * 100
      : 0;
  const unlockVsVolume =
    (market.avg_30d_volume_usd ?? 0) > 0
      ? supply.real_sellable_supply / (market.avg_30d_volume_usd ?? 1)
      : 0;

  const report: IntelligenceReport = {
    token_symbol: symbol,
    next_unlock_date: nextUnlock ? new Date(nextUnlock).toISOString() : "",
    unlock_amount: unlockAmount,
    unlock_percent_supply: percentSupply,
    unlock_vs_volume_ratio: unlockVsVolume,
    cohort_type: cohortType,
    historical_avg_7d_return: 0,
    impact_score: riskLevelToScoreString(scoring.risk_level),
    risk_level: scoring.risk_level,
    risk_summary: scoring.explanation,
    score_numeric: scoring.score,
    explanation: scoring.explanation,
    primary_driver: scoring.primary_driver,
    sell_pressure_estimate: scoring.sell_pressure_estimate,
    sellable_supply: toReportSellableSupply(supply),
    fetched_at: new Date().toISOString(),
  };

  try {
    const chainIds = await getChainIdsForToken(symbol);
    if (chainIds.length > 1 || (chainIds.length === 1 && chainIds[0] !== "ethereum")) {
      const chains: Record<string, ChainReport> = {};
      let weightedSum = 0;
      let weightSum = 0;
      for (const cid of chainIds) {
        try {
          const chainSupply = await computeSellableSupply(symbol, market.avg_30d_volume_usd ?? undefined, cid);
          const chainScoringInput = buildScoringInput(symbol, market, chainSupply, cohortType, 0, 0);
          const chainScoring: ScoringOutput = computeImpactScore(chainScoringInput);
          const chainPercent =
            chainSupply.scheduled_amount > 0
              ? (chainSupply.real_sellable_supply / chainSupply.scheduled_amount) * 100
              : 0;
          chains[cid] = {
            next_unlock_date: nextUnlock ? new Date(nextUnlock).toISOString() : "",
            unlock_amount: chainSupply.claimed_amount,
            unlock_percent_supply: chainPercent,
            risk_level: chainScoring.risk_level,
            score_numeric: chainScoring.score,
            sellable_supply: toReportSellableSupply(chainSupply),
          };
          const weight = Math.max(chainSupply.real_sellable_supply, chainSupply.claimed_amount, 1);
          weightedSum += chainScoring.score * weight;
          weightSum += weight;
        } catch (err) {
          logger.warn({ err, stage: "chain_report", chain_id: cid, token_symbol: symbol }, "Chain report failed");
        }
      }
      report.chains = Object.keys(chains).length > 0 ? chains : undefined;
      report.combined_score =
        weightSum > 0 ? Math.round(Math.min(100, Math.max(0, weightedSum / weightSum))) : scoring.score;
    }
  } catch (err) {
    logger.warn({ err, stage: "multichain", token_symbol: symbol }, "Multi-chain stage failed");
  }

  return report;
}
