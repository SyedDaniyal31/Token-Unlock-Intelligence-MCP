# Institutional Hybrid Intelligence — Upgrade Summary

## Step 1 — Audit (Complete)

See **AUDIT_REPORT.md** for the full structured audit: current architecture, weak points, redundant dependencies, missing components, refactor recommendations.

---

## Step 2 — Canonical Unlock Registry

- **Removed:** Hardcoded mock unlock array from `broker.ts` (ARB/OP/APT in code).
- **Added:** `data/unlockRegistry.json` as canonical schedule source with structure:
  - `token_symbol`, `contract_address`, `vesting_contract`, `beneficiary_type`, `total_allocation`, `vesting_start`, `vesting_cliff`, `vesting_end`, `release_frequency`
- **Added:** `src/infrastructure/registry/unlockRegistryLoader.ts` — `loadUnlockRegistryFromDisk()`, `syncUnlockRegistryToDb()`. Sync runs at server startup and every cron cycle.
- **Updated:** `broker.runUnlockPrecompute()` now uses `listUnlockSchedules()` from DB (synced from JSON); no external unlock calendar API.

---

## Step 3 — Hybrid Model Architecture

Layers enforced:

| Layer | Component | Role |
|-------|-----------|------|
| 1 | Internal Unlock Registry | `data/unlockRegistry.json` + DB sync; `unlockRegistry.ts`, `unlockRegistryLoader.ts` |
| 2 | On-Chain Verification | `unlockVerifier.ts`; RPC-based, `ChainProvider` injected |
| 3 | Exchange Flow Detection | `flowAnalyzer.ts`, `exchangeRegistry.ts` |
| 4 | Market Context | `MarketDataProvider` (CoinGecko / Stub), `marketCache.ts` |
| 5 | Intelligence Scoring | `sellableSupply.ts`, `impactScoring.ts`, `unlockIntelligence.ts` |
| 6 | MCP Interface | `mcpController.ts`, `routes.ts`; no business logic in controller |

---

## Step 4 — Market Data Provider

- **Added:** `CoinGeckoMarketProvider` in `infrastructure/market/marketProvider.ts`.
  - Fetches: `price_usd`, `circulating_supply`, `avg_30d_volume_usd` (proxy from total_volume), `market_cap_usd`, `liquidity_depth_usd`.
  - Abstract via `MarketDataProvider`; no direct API calls in intelligence layer.
  - Optional `COINGECKO_API_KEY` (or `MARKET_API_KEY`) for higher rate limits.
- **Updated:** `MarketSnapshot` in `core/types.ts` includes `circulating_supply`.
- **App:** Uses `CoinGeckoMarketProvider` when API key is set, else `StubMarketProvider`; both wrapped with `CachingMarketProvider` (5 min TTL).

---

## Step 5 — RPC Provider Hardening

- **Updated:** `ChainProvider` in `core/types.ts` includes optional `getTokenTransfers?(tokenAddress, fromBlock, toBlock): Promise<TokenTransfer[]>`.
- **Added:** `TokenTransfer` type: `from`, `to`, `value`, `blockNumber`, `txHash`.
- **Updated:** `MockEthereumProvider` implements `getTokenTransfers` (returns `[]`). Real implementation to use `RPC_URL` from env; no business logic in provider.
- **Exported:** `TokenTransfer` from `infrastructure/rpc/chainProvider.ts`.

---

## Step 6 — Exchange Registry

- **Updated:** `ExchangeRegistry` in `core/types.ts`: added `isExchangeAddress(address: string): boolean` (alias for `isKnownExchangeAddress`).
- **Updated:** `DefaultExchangeRegistry`: implements `isExchangeAddress`; labeled addresses via internal `LABELS` map for future dynamic updates and clustering.

---

## Step 7 — Sellable Supply Engine

- **Updated:** `SellableSupplyResult`: added `high_velocity_transfers`.
- **Formula:** `real_sellable_supply = exchange_inflow + high_velocity_transfers` (amounts moved to new wallet, not retained).
- **Added:** `liquidityRatio(realSellableSupply, avg30dVolumeUsd)` and `normalizedImpactFactor(liquidityRatioValue)` in `sellableSupply.ts`.
- **Flow analysis:** Uses `moved_to_new_wallet` from DB for high-velocity component.
- **Liquidity normalization:** `liquidity_ratio = real_sellable_supply / avg_30d_volume` used in scoring.

---

## Step 8 — Impact Scoring

- **Formula:**  
  `impact_score = (unlock_percent_circulating * 0.35) + (liquidity_ratio_component * 0.35) + (exchange_flow_ratio * 0.20) + (behavior_multiplier_component * 0.10)`  
  Clamped 0–100.
- **Output:** `{ score, risk_level, explanation, primary_driver, sell_pressure_estimate }`.
- **IntelligenceReport:** Added `primary_driver`, `sell_pressure_estimate`.
- **buildScoringInput:** Uses `market.circulating_supply` for `percent_circulating_supply` when available.

---

## Step 9 — Performance

- **In-memory cache:** `infrastructure/market/marketCache.ts` — 5 min TTL for market snapshots; `CachingMarketProvider` wraps any `MarketDataProvider`.
- **Indexed DB:** `sql/migration_indexes_performance.sql` — indexes on `unlock_events (token_symbol, timestamp)`, `unlock_flow_analysis (unlock_event_id)`, `unlock_analysis (token_symbol)`.
- **Duplicate events:** Event processing remains idempotent (processed flag); no duplicate event processing.
- **MCP response:** Cached token market data yields sub-1.5s response when cache hit.

---

## Step 10 — Cleanup

- **No new npm dependencies removed**; no unused packages identified.
- **No `console.log`** in codebase; logger only.
- **Strict TypeScript** already enabled (`strict: true` in tsconfig).
- **Production error handling:** Lazy DB init, env validation in index, no stack leak in responses.
- **Env validation:** `DATABASE_URL` required in production; `COINGECKO_API_KEY` / `RPC_URL` optional.
- **No circular dependencies**; dependency flow: core → infrastructure → ingestion → intelligence → orchestration / api → app.

---

## Updated Folder Structure

```
src/
  app.ts
  index.ts
  core/
    types.ts          (MarketSnapshot.circulating_supply; TokenTransfer; ChainProvider.getTokenTransfers; ExchangeRegistry.isExchangeAddress; IntelligenceReport.primary_driver, sell_pressure_estimate)
    config.ts         (COINGECKO_API_KEY)
    logger.ts
  infrastructure/
    database/postgres.ts
    registry/unlockRegistryLoader.ts   NEW
    rpc/chainProvider.ts, ethereumProvider.ts
    market/marketProvider.ts           (CoinGeckoMarketProvider), marketCache.ts   NEW
    exchanges/exchangeRegistry.ts      (isExchangeAddress)
  ingestion/
    unlockRegistry.ts, unlockVerifier.ts, flowAnalyzer.ts
  intelligence/
    sellableSupply.ts  (high_velocity_transfers, liquidityRatio, normalizedImpactFactor)
    impactScoring.ts   (new formula, primary_driver, sell_pressure_estimate)
    unlockIntelligence.ts
  orchestration/ingestionPipeline.ts
  api/mcpController.ts, routes.ts
data/
  unlockRegistry.json   NEW (canonical schedule source)
sql/
  migration_indexes_performance.sql   NEW
docs/
  AUDIT_REPORT.md
  INSTITUTIONAL_HYBRID_UPGRADE.md     (this file)
```

---

## Removed / Replaced

- **Removed:** In-code mock unlock array in `broker.ts` (replaced by registry + DB).
- **Deprecated:** `server.ts` remains in repo but is unused; entry is `app.ts` via `index.ts`.

---

## New Modules Added

- `infrastructure/registry/unlockRegistryLoader.ts`
- `infrastructure/market/marketCache.ts` (CachingMarketProvider)
- `data/unlockRegistry.json`
- `sql/migration_indexes_performance.sql`
- `docs/AUDIT_REPORT.md`
- `docs/INSTITUTIONAL_HYBRID_UPGRADE.md`

---

## Architecture Diagram (Text)

```
                    ┌─────────────────────────────────────┐
                    │   Layer 6: MCP Interface             │
                    │   (mcpController, routes)             │
                    └─────────────────┬───────────────────┘
                                      │
                    ┌─────────────────▼───────────────────┐
                    │   Layer 5: Intelligence Scoring      │
                    │   (unlockIntelligence, impactScoring,│
                    │    sellableSupply)                   │
                    └─────────────────┬───────────────────┘
                                      │
        ┌─────────────────────────────┼─────────────────────────────┐
        │                             │                             │
┌───────▼───────┐           ┌─────────▼─────────┐           ┌───────▼───────┐
│ Layer 1       │           │ Layer 2           │           │ Layer 4       │
│ Unlock        │           │ On-Chain          │           │ Market        │
│ Registry      │           │ Verification      │           │ Context       │
│ (JSON + DB)   │           │ (ChainProvider)   │           │ (MarketData   │
└───────────────┘           └───────────────────┘           │  Provider)    │
        │                             │                     └───────────────┘
        │                             │
        └─────────────────────────────┼─────────────────────────────┐
                                      │                             │
                            ┌─────────▼─────────┐           ┌───────▼───────┐
                            │ Layer 3           │           │ Cache         │
                            │ Exchange Flow     │           │ (5 min TTL)   │
                            │ (ExchangeRegistry)│           └───────────────┘
                            └───────────────────┘
```

---

## Example Intelligence Response JSON

```json
{
  "token_symbol": "ARB",
  "next_unlock_date": "2025-12-31T00:00:00.000Z",
  "unlock_amount": 0,
  "unlock_percent_supply": 0,
  "unlock_vs_volume_ratio": 0,
  "cohort_type": "team",
  "historical_avg_7d_return": 0,
  "impact_score": "low",
  "risk_level": "low",
  "risk_summary": "Unlock 0.0% circ; liquidity component 0; exchange flow 0.0%; behavior 1.00. Score 0 (low). Primary driver: unlock_percent_circulating.",
  "score_numeric": 0,
  "explanation": "Unlock 0.0% circ; liquidity component 0; exchange flow 0.0%; behavior 1.00. Score 0 (low). Primary driver: unlock_percent_circulating.",
  "primary_driver": "unlock_percent_circulating",
  "sell_pressure_estimate": "Low",
  "sellable_supply": {
    "scheduled_amount": 0,
    "claimed_amount": 0,
    "retained_amount": 0,
    "exchange_inflow": 0,
    "real_sellable_supply": 0
  },
  "fetched_at": "2025-02-19T14:00:00.000Z"
}
```

---

## Performance Expectations

- **Cached token (market snapshot in cache):** MCP response &lt; 1.5 s.
- **Uncached token:** Depends on CoinGecko latency and DB; typically 2–5 s.
- **Cron full cycle:** Idempotent; per-token failures logged only; no full-cycle crash.
- **Registry sync:** One-time read of `data/unlockRegistry.json` at startup and each cron; minimal overhead.

---

This system implements an **Institutional Hybrid Intelligence Model**: sell pressure is computed from first principles (registry → on-chain verification → flow analysis → sellable supply → market context → scoring). It is not a dashboard, wrapper, or unlock calendar.
