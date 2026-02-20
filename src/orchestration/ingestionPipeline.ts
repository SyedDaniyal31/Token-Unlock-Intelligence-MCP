import type { ChainProvider } from "../core/types.js";
import type { ExchangeRegistry } from "../core/types.js";
import { query } from "../infrastructure/database/postgres.js";
import logger from "../core/logger.js";
import { listUnlockSchedules } from "../ingestion/unlockRegistry.js";
import { verifyUnlocksOnChain, getUnprocessedEvents, markEventProcessed } from "../ingestion/unlockVerifier.js";
import { analyzeUnlockFlow } from "../ingestion/flowAnalyzer.js";
import { computeSellableSupply } from "../intelligence/sellableSupply.js";

const UPSERT_ANALYSIS_SQL = `
INSERT INTO unlock_analysis (
  token_symbol, next_unlock_date, unlock_amount, unlock_percent_supply,
  avg_30d_volume_usd, unlock_vs_volume_ratio, cohort_type, historical_avg_7d_return,
  impact_score, risk_summary, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
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

export interface IngestionPipelineDeps {
  chainProvider: ChainProvider;
  exchangeRegistry: ExchangeRegistry;
}

export async function runFullIngestionCycle(deps: IngestionPipelineDeps): Promise<void> {
  try {
    const { eventsInserted, schedulesProcessed } = await verifyUnlocksOnChain(deps.chainProvider);
    logger.info({ step: "verify", eventsInserted, schedulesProcessed });

    const events = await getUnprocessedEvents();
    for (const event of events) {
      try {
        await analyzeUnlockFlow(
          {
            id: event.id,
            token_symbol: event.token_symbol,
            event_type: event.event_type,
            amount: event.amount,
            recipient_address: event.recipient_address,
          },
          deps.exchangeRegistry
        );
        await markEventProcessed(event.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({
          step: "analyze_flow",
          unlock_event_id: event.id,
          token_symbol: event.token_symbol,
          error: message,
        });
      }
    }

    const schedules = await listUnlockSchedules();
    const tokenSymbols = [...new Set(schedules.map((s) => s.token_symbol))];

    for (const tokenSymbol of tokenSymbols) {
      try {
        const supply = await computeSellableSupply(tokenSymbol);
        const schedule = schedules.find((s) => s.token_symbol === tokenSymbol);
        const nextUnlock = schedule?.vesting_end ?? null;
        const cohortType = schedule?.beneficiary_label ?? null;
        const avg30d = 0;
        const ratio =
          supply.scheduled_amount > 0 && avg30d > 0
            ? supply.real_sellable_supply / avg30d
            : 0;

        await query(UPSERT_ANALYSIS_SQL, [
          tokenSymbol,
          nextUnlock,
          supply.real_sellable_supply,
          supply.scheduled_amount > 0
            ? (supply.real_sellable_supply / supply.scheduled_amount) * 100
            : 0,
          avg30d,
          ratio,
          cohortType,
          null,
          "low",
          `Sellable supply: ${supply.real_sellable_supply.toFixed(0)}.`,
        ]);
        logger.info({
          step: "upsert_analysis",
          token_symbol: tokenSymbol,
          sellable_amount: supply.real_sellable_supply,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({
          step: "compute_sellable",
          token_symbol: tokenSymbol,
          error: message,
        });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ scope: "runFullIngestionCycle", error: message });
  }
}
