# Institutional Refactor & Optimization (From Audit)

Surgical refactor based on audit. No full rewrite; working modules preserved.

---

## Phase 1 — Single Source of Truth

**Removed**
- Hardcoded unlock array from broker (ARB, OP, APT).
- Legacy ingestion modules: `ingestion/registry.ts`, `ingestion/verification.ts`, `ingestion/flowAnalysis.ts`, `ingestion/pipeline.ts`.
- Dead entry point: `server.ts`.

**Canonical source**
- `data/unlockRegistry.json` — single source for unlock schedules (token_symbol, contract_address, vesting_contract, beneficiary_type, total_allocation, vesting_start/cliff/end, release_frequency).
- `syncUnlockRegistryToDb()` loads JSON and syncs to DB on startup and each cron cycle (exported from `ingestion/index.ts`).
- DB is the runtime query layer; JSON is source of truth.

**Kept**
- `ingestion/unlockRegistry.ts` — DB CRUD and queries.
- `ingestion/unlockVerifier.ts` — on-chain verification (ChainProvider injected).
- `ingestion/flowAnalyzer.ts` — flow analysis (ExchangeRegistry injected).
- `orchestration/ingestionPipeline.ts` — full ingestion cycle.

**Broker**
- Uses `listUnlockSchedules()` from `unlockRegistry` only.
- `initializeUnlockEngine()` now only runs `runUnlockPrecompute()` (no legacy pipeline).

---

## Phase 2 — Real Market Data Provider

**MarketSnapshot** (`core/types.ts`):
- `price` (as `price_usd`), `circulating_supply`, `avg_30d_volume_usd`, `market_cap_usd`, `liquidity_depth_usd`, `fetched_at`.

**CoinGeckoMarketProvider**
- Implements `MarketDataProvider`.
- Fetches price, circulating_supply, 30d volume (proxy from total_volume), market_cap.
- No business logic in provider.
- Optional `COINGECKO_API_KEY` / `MARKET_API_KEY`.

**Cache**
- 5-minute in-memory TTL in `infrastructure/market/marketCache.ts`.
- `CachingMarketProvider` wraps any provider; used in app.

---

## Phase 3 — Chain Provider Upgrade

**ChainProvider** (`core/types.ts`):
- `getLogs(contractAddress, fromBlock, toBlock): Promise<RawChainLog[]>`
- `getBlock(blockNumber): Promise<RawChainBlock | null>`
- `getTokenTransfers(tokenAddress, fromBlock, toBlock): Promise<TokenTransfer[]>` (optional)

**EthereumRpcProvider** (`infrastructure/rpc/ethereumRpcProvider.ts`):
- Uses `process.env.RPC_URL` (or constructor arg).
- Implements all three methods via JSON-RPC (`eth_getLogs`, `eth_getBlockByNumber`, `eth_getLogs` with Transfer topic for token transfers).
- Chain-agnostic; no business logic; single-request RPC.

**App**
- Uses `EthereumRpcProvider` when `RPC_URL` is set; otherwise `MockEthereumProvider` (tests / no RPC).

---

## Phase 4 — Exchange Registry

**Interface**
- `isKnownExchangeAddress(address)` — unchanged.
- `isExchangeAddress(address)` — alias.
- `getExchangeLabel(address)` — label or null.
- **`getExchangeInfo(address): { isExchange: boolean; exchangeLabel?: string }`** — new.

**DefaultExchangeRegistry**
- Implements `getExchangeInfo`; labels in a `LABELS` map for future dynamic loading.
- No hardcoded logic inside business layers; registry is injected.

---

## Phase 5 — Sellable Supply Engine

**SellableSupplyResult** now includes:
- `scheduled_amount`, `claimed_amount`, `retained_amount`, `exchange_inflow`, `high_velocity_transfers`, `real_sellable_supply`
- **`liquidity_ratio`** = `real_sellable_supply / avg_30d_volume` (when `avg30dVolumeUsd` passed; else 0).
- **`exchange_flow_ratio`** = `exchange_inflow / claimed_amount` (0 when claimed_amount is 0).

**computeSellableSupply(tokenSymbol, avg30dVolumeUsd?)**
- Optional second argument for 30d volume so liquidity_ratio is filled when market data is available.
- DB queries use existing indexes (`token_symbol`, `timestamp`, `unlock_event_id`).

---

## Phase 6 — Impact Scoring

**Formula** (clamped 0–100):
- `impact_score = (unlock_percent_circulating * 0.35) + (liquidity_ratio_component * 0.35) + (exchange_flow_ratio * 0.20) + (behavior_multiplier_component * 0.10)`.

**Return**
- `score`, `risk_level`, `explanation`, **`primary_driver`** (largest weighted component), **`sell_pressure_estimate`** (qualitative from liquidity_ratio: Very high / High / Moderate / Low).

**ScoringInput**
- Optional `liquidity_ratio`; when set, `sell_pressure_estimate` is derived from liquidity_ratio bands (e.g. ≥1 → Very high, ≥0.5 → High, ≥0.2 → Moderate, else Low).

---

## Phase 7 — Performance

- 5 min TTL cache for market snapshots (Phase 2).
- Unlock event processing remains idempotent (processed flag).
- DB indexes: `sql/migration_indexes_performance.sql` and schema indexes on token_symbol, block_number, timestamp, unlock_event_id.
- Target: &lt; 1.5s response when market data is cached.

---

## Phase 8 — Clean Architecture

- **6 layers:** Registry (JSON + DB) → On-Chain Verification → Flow Analysis → Sellable Supply → Intelligence Scoring → MCP Controller.
- No business logic in controller (mcpController only delegates to `generateUnlockIntelligence`).
- No provider calls inside scoring layer (scoring receives normalized inputs).
- No circular dependencies; strict TypeScript; no console.log; production-safe error handling.
- **Removed:** `server.ts` (dead entry). Entry: `index.ts` → `app.ts`.

---

## Updated Folder Structure

```
src/
  index.ts
  app.ts
  core/
    types.ts         (MarketSnapshot, ExchangeInfo, ChainProvider.getTokenTransfers, TokenTransfer)
    config.ts
    logger.ts
  infrastructure/
    database/postgres.ts
    registry/unlockRegistryLoader.ts
    rpc/
      chainProvider.ts
      ethereumProvider.ts      (Mock)
      ethereumRpcProvider.ts   (NEW — real RPC)
    market/
      marketProvider.ts        (Stub, CoinGecko)
      marketCache.ts
    exchanges/exchangeRegistry.ts  (getExchangeInfo)
  ingestion/
    index.ts         (canonical exports + syncUnlockRegistryToDb)
    unlockRegistry.ts
    unlockVerifier.ts
    flowAnalyzer.ts
  intelligence/
    sellableSupply.ts   (liquidity_ratio, exchange_flow_ratio in result)
    impactScoring.ts    (primary_driver, sell_pressure from liquidity_ratio)
    unlockIntelligence.ts
  orchestration/ingestionPipeline.ts
  api/
    mcpController.ts
    routes.ts
data/
  unlockRegistry.json
```

---

## Removed Modules

- `src/ingestion/registry.ts`
- `src/ingestion/verification.ts`
- `src/ingestion/flowAnalysis.ts`
- `src/ingestion/pipeline.ts`
- `src/server.ts`

---

## New / Updated Modules

- **New:** `src/infrastructure/rpc/ethereumRpcProvider.ts` (real RPC using RPC_URL).
- **Updated:** `ingestion/index.ts` — exports only canonical ingestion + `syncUnlockRegistryToDb`.
- **Updated:** `core/types.ts` — `ExchangeInfo`, `getExchangeInfo` on ExchangeRegistry.
- **Updated:** `infrastructure/exchanges/exchangeRegistry.ts` — `getExchangeInfo`.
- **Updated:** `intelligence/sellableSupply.ts` — `liquidity_ratio`, `exchange_flow_ratio` in result; optional `avg30dVolumeUsd` param.
- **Updated:** `intelligence/impactScoring.ts` — `liquidity_ratio` in input; `sell_pressure_estimate` from liquidity_ratio.
- **Updated:** `app.ts` — uses `EthereumRpcProvider` when RPC_URL set; sync from `ingestion/index`.

---

## ChainProvider Interface (Final)

```ts
interface ChainProvider {
  getLogs(contractAddress: string, fromBlock: number, toBlock: number): Promise<RawChainLog[]>;
  getBlock(blockNumber: number): Promise<RawChainBlock | null>;
  getTokenTransfers?(tokenAddress: string, fromBlock: number, toBlock: number): Promise<TokenTransfer[]>;
}
```

---

## MarketSnapshot (Final)

```ts
interface MarketSnapshot {
  token_symbol: string;
  price_usd: number;
  circulating_supply: number;
  avg_30d_volume_usd: number;
  market_cap_usd: number;
  liquidity_depth_usd: number;
  fetched_at: string;
}
```

---

## Example IntelligenceReport JSON

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
  "fetched_at": "2025-02-19T16:00:00.000Z"
}
```

---

## Performance Expectations

- **Cached token:** MCP response &lt; 1.5 s (market snapshot from 5 min cache).
- **Uncached:** Dominated by CoinGecko and DB; typically 2–5 s.
- **Idempotent:** Event processing uses `processed` flag; no duplicate handling.
- **Indexed:** Queries use indexes on token_symbol, block_number, timestamp, unlock_event_id.

---

**Institutional Hybrid Intelligence Infrastructure:** Sell pressure is computed from first principles (registry → on-chain verification → flow analysis → sellable supply → market context → scoring). No dependency on external unlock calendar APIs; APIs used only for market context; the intelligence layer is fully owned.
