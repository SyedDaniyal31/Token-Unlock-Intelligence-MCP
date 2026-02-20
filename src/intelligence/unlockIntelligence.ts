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

export interface UnlockIntelligenceDeps {
  chainProvider: ChainProvider;
  marketProvider: MarketDataProvider;
  exchangeRegistry: ExchangeRegistry;
}

function riskLevelToScoreString(risk: RiskLevel): string {
  return risk;
}

export async function generateUnlockIntelligence(
  tokenSymbol: string,
  deps: UnlockIntelligenceDeps
): Promise<IntelligenceReport> {
  const symbol = tokenSymbol.trim().toUpperCase();
  const metadata = await getScheduleByToken(symbol);
  await verifyUnlocksOnChain(deps.chainProvider);

  const events = await getUnprocessedEvents();
  const tokenEvents = events.filter((e) => e.token_symbol === symbol);
  for (const event of tokenEvents) {
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
  }

  const market = await deps.marketProvider.getMarketSnapshot(symbol);
  const supply = await computeSellableSupply(symbol, market.avg_30d_volume_usd);
  const cohortType = metadata?.beneficiary_label ?? "ecosystem";
  const scoringInput = buildScoringInput(
    symbol,
    market,
    supply,
    cohortType,
    0,
    0
  );
  const scoring: ScoringOutput = computeImpactScore(scoringInput);

  const nextUnlock = metadata?.vesting_end ?? null;
  const unlockAmount = supply.claimed_amount;
  const percentSupply =
    supply.scheduled_amount > 0
      ? (supply.real_sellable_supply / supply.scheduled_amount) * 100
      : 0;
  const unlockVsVolume =
    market.avg_30d_volume_usd > 0
      ? supply.real_sellable_supply / market.avg_30d_volume_usd
      : 0;

  const report: IntelligenceReport = {
    token_symbol: symbol,
    next_unlock_date: nextUnlock ? new Date(nextUnlock).toISOString() : "",
    unlock_amount: unlockAmount,
    unlock_percent_supply: percentSupply,
    unlock_vs_volume_ratio: unlockVsVolume,
    cohort_type: cohortType,
    historical_avg_7d_return: scoringInput.avg_7d_return_post_unlock,
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

  const chainIds = await getChainIdsForToken(symbol);
  if (chainIds.length > 1 || (chainIds.length === 1 && chainIds[0] !== "ethereum")) {
    const chains: Record<string, ChainReport> = {};
    let weightedSum = 0;
    let weightSum = 0;
    for (const cid of chainIds) {
      const chainSupply = await computeSellableSupply(symbol, market.avg_30d_volume_usd, cid);
      const chainScoringInput = buildScoringInput(
        symbol,
        market,
        chainSupply,
        cohortType,
        0,
        0
      );
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
    }
    report.chains = chains;
    report.combined_score =
      weightSum > 0 ? Math.round(Math.min(100, Math.max(0, weightedSum / weightSum))) : scoring.score;
  }

  return report;
}
