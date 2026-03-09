/**
 * Coverage test: run analyze_token_supply_risk for ENA, HYPE, ARB, OP, TIA, STRK, SUI.
 * Asserts each returns either successful unlock analysis or the explicit no-data message
 * (no silent failures).
 *
 * Run: npx ts-node --esm src/scripts/testUnlockCoverage.ts
 * Or: npm run build && node dist/scripts/testUnlockCoverage.js (with dotenv preloaded)
 */

import "dotenv/config";
import { getChainProvider } from "../infrastructure/rpc/chainProviderFactory.js";
import { StubMarketProvider, CoinGeckoMarketProvider } from "../infrastructure/market/marketProvider.js";
import { CachingMarketProvider } from "../infrastructure/market/marketCache.js";
import { DefaultExchangeRegistry } from "../infrastructure/exchanges/exchangeRegistry.js";
import type { UnlockIntelligenceDeps } from "../intelligence/unlockIntelligence.js";
import { runAnalyzeTokenSupplyRisk } from "../tools/analyze_token_supply_risk.js";
import {
  UNLOCK_UNAVAILABLE_ACROSS_SOURCES,
  USER_MESSAGE_NO_VERIFIED_UNLOCK,
  DOCS_DERIVE_FAILURE_REASON,
} from "../tools/analyze_token_supply_risk.js";
import { config } from "../core/config.js";

const TOKENS = ["ENA", "HYPE", "ARB", "OP", "TIA", "STRK", "SUI"] as const;

/** ENA and HYPE must return structured unlock analysis (data or docs-derived failure message). */
const DOCS_FALLBACK_TOKENS = new Set(["ENA", "HYPE"]);

function buildDeps(): UnlockIntelligenceDeps {
  const chainProvider = getChainProvider("ethereum");
  const baseMarket = config.COINGECKO_API_KEY
    ? new CoinGeckoMarketProvider(config.COINGECKO_API_KEY)
    : new StubMarketProvider();
  const marketProvider = new CachingMarketProvider(baseMarket);
  const exchangeRegistry = new DefaultExchangeRegistry();
  return { chainProvider, marketProvider, exchangeRegistry };
}

function isUnlockDataPresent(data: Record<string, unknown>): boolean {
  const hasUnlock =
    data.analysis_provenance &&
    typeof data.analysis_provenance === "object" &&
    (data.analysis_provenance as Record<string, unknown>).unlock_data_available === true;
  const hasNext =
    data.next_estimated_unlock_timestamp != null &&
    Number.isFinite(data.next_estimated_unlock_timestamp);
  const hasProvider =
    data.unlock_provider != null && String(data.unlock_provider).length > 0;
  return Boolean(hasUnlock || hasNext || hasProvider);
}

function isExplicitNoData(data: Record<string, unknown>): boolean {
  const reason = data.no_results_reason;
  const message = data.message;
  const hasReason =
    reason === UNLOCK_UNAVAILABLE_ACROSS_SOURCES ||
    reason === DOCS_DERIVE_FAILURE_REASON ||
    (typeof reason === "string" && reason.length > 0);
  const hasMessage =
    message === USER_MESSAGE_NO_VERIFIED_UNLOCK ||
    message === DOCS_DERIVE_FAILURE_REASON ||
    (typeof message === "string" && message.includes("TokenUnlocks") && message.includes("DefiLlama")) ||
    (typeof message === "string" && message.includes("could not be derived"));
  return Boolean(
    (hasReason && hasMessage) ||
      (hasReason && (data.analysis_completion_status === "completed_no_data" || data.search_exhausted === true))
  );
}

async function main(): Promise<void> {
  const deps = buildDeps();
  let passed = 0;
  let failed = 0;

  for (const symbol of TOKENS) {
    try {
      const result = await runAnalyzeTokenSupplyRisk(
        { token_symbol: symbol, timeframe_days: 30 },
        deps
      );

      if (!result.success) {
        console.log(`FAIL ${symbol}: success=false, error=${(result as { error?: string }).error}`);
        failed++;
        continue;
      }

      const data = (result as unknown as { data: Record<string, unknown> }).data;
      if (data == null || typeof data !== "object") {
        console.log(`FAIL ${symbol}: missing data`);
        failed++;
        continue;
      }

      if ("status" in data && data.status === "unsupported_chain") {
        console.log(`OK   ${symbol}: unsupported_chain (explicit)`);
        passed++;
        continue;
      }

      const flat = data as Record<string, unknown>;
      if (isUnlockDataPresent(flat)) {
        const provider = flat.unlock_provider ?? "unknown";
        const next = flat.next_estimated_unlock_timestamp;
        console.log(`OK   ${symbol}: unlock data from ${provider}, next_ts=${next ?? "n/a"}`);
        passed++;
        continue;
      }

      if (isExplicitNoData(flat)) {
        const reason = flat.no_results_reason ?? "no_results_reason";
        const isDocsFailure = reason === DOCS_DERIVE_FAILURE_REASON;
        if (DOCS_FALLBACK_TOKENS.has(symbol as (typeof TOKENS)[number]) && isDocsFailure) {
          console.log(`OK   ${symbol}: structured docs failure (no schedule from APIs or docs)`);
        } else {
          console.log(`OK   ${symbol}: no data (explicit): ${reason}`);
        }
        passed++;
        continue;
      }

      if (DOCS_FALLBACK_TOKENS.has(symbol as (typeof TOKENS)[number])) {
        console.log(
          `FAIL ${symbol}: ENA/HYPE must return unlock analysis or "Unlock schedule could not be derived from APIs or documentation". ` +
            `Got no_results_reason=${flat.no_results_reason ?? "undefined"}, message=${flat.message ?? "undefined"}`
        );
      } else {
        console.log(
          `FAIL ${symbol}: no unlock data and no explicit no-data message. ` +
            `no_results_reason=${flat.no_results_reason ?? "undefined"}, message=${flat.message ?? "undefined"}`
        );
      }
      failed++;
    } catch (err) {
      console.log(`FAIL ${symbol}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  console.log("\n---");
  console.log(`Passed: ${passed}/${TOKENS.length}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
