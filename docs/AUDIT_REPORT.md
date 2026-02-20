# Full Project Audit — Token Unlock Intelligence MCP

## Current architecture summary

- **Entry:** `index.ts` → `app.ts` (Express, MCP SDK, cron). Legacy `server.ts` exists but is unused.
- **Layers:** Core (types, config, logger); Infrastructure (postgres, rpc/MockEthereumProvider, market/StubMarketProvider, exchanges/DefaultExchangeRegistry); Ingestion (unlockRegistry, unlockVerifier, flowAnalyzer + legacy registry, verification, flowAnalysis, pipeline); Intelligence (sellableSupply, impactScoring, unlockIntelligence); Orchestration (ingestionPipeline); API (mcpController, routes).
- **Data flow:** Unlock schedules in DB (`unlock_schedules`). Broker’s `loadUnlockData()` returns **hardcoded mock data** (ARB, OP, APT) for precompute; no public unlock calendar API. On-chain verification uses `ChainProvider.getLogs`/`getBlock` (mock returns []). Exchange flow uses `ExchangeRegistry.isKnownExchangeAddress`. Market data uses `MarketDataProvider.getMarketSnapshot` (stub returns zeros). Scoring uses size/liquidity/cohort/historical/regime/behavioral; output is score, risk_level, explanation.

## Weak points

1. **Canonical schedule source:** Schedules are DB-only; broker precompute uses in-code mock data instead of a single canonical source (e.g. JSON registry + DB sync).
2. **No real market data:** Only `StubMarketProvider`; no price, circulating supply, or 30d volume from an API (e.g. CoinGecko).
3. **ChainProvider incomplete:** Missing `getTokenTransfers`; not using `RPC_URL` from env in a real implementation.
4. **Exchange registry:** Method is `isKnownExchangeAddress`; no `isExchangeAddress` alias; addresses are hardcoded; no dynamic/labeled registry for future clustering.
5. **Sellable supply formula:** Uses exchange_inflow and retained; no explicit “high_velocity_transfers” or liquidity_ratio normalization for impact.
6. **Scoring formula:** Current weights differ from desired (e.g. 0.35/0.35/0.20/0.10 for unlock%, liquidity_ratio, exchange_flow_ratio, behavior); no primary_driver or sell_pressure_estimate in output.
7. **Performance:** No in-memory caching for market data; no batch RPC; no cache TTL; duplicate event processing possible if not idempotent.
8. **Duplicate paths:** Old ingestion (registry, verification, flowAnalysis, pipeline) and new (unlockRegistry, unlockVerifier, flowAnalyzer) plus broker mock data create multiple sources of truth.

## Redundant dependencies

- All listed deps are used. No redundant npm packages. `server.ts` is dead code (redundant with `app.ts`).

## Missing intelligence components

- **Canonical unlock registry:** JSON file (e.g. `data/unlockRegistry.json`) as source of truth, synced to DB.
- **Market data:** Real provider (e.g. CoinGecko) with price, circulating_supply, avg_30d_volume.
- **ChainProvider:** `getTokenTransfers` and use of `RPC_URL`.
- **Exchange registry:** `isExchangeAddress` (or alias), labeled addresses, room for dynamic updates.
- **Sellable supply:** high_velocity_transfers, liquidity_ratio = real_sellable_supply / avg_30d_volume, normalized impact factor.
- **Scoring output:** primary_driver, sell_pressure_estimate; formula weights 0.35/0.35/0.20/0.10.
- **Caching:** 5-min TTL for market data; batch RPC; indexed queries; target &lt; 1.5s for cached MCP response.

## Refactor recommendations

1. Add `data/unlockRegistry.json` as canonical schedule source; seed/sync DB from it; remove broker mock array; keep broker precompute but feed from registry/DB.
2. Implement `CoinGeckoMarketProvider` (or generic) behind `MarketDataProvider`; add circulating_supply to `MarketSnapshot`.
3. Extend `ChainProvider` with `getTokenTransfers`; add real Ethereum provider using `RPC_URL`; keep chain-agnostic interface.
4. Rename or alias `isKnownExchangeAddress` → `isExchangeAddress`; keep exchange registry in infrastructure with labeled addresses and future dynamic updates.
5. Upgrade sellable supply to include high_velocity_transfers and liquidity_ratio; return normalized impact factor.
6. Reweight impact scoring to (unlock_percent_circulating * 0.35) + (liquidity_ratio * 0.35) + (exchange_flow_ratio * 0.20) + (behavior * 0.10); add primary_driver and sell_pressure_estimate.
7. Add in-memory cache (5 min TTL) for market snapshots; batch log queries where possible; ensure idempotent event processing; add DB indexes for hot queries.
8. Remove or deprecate `server.ts`; ensure single entry (app.ts). Enforce six layers strictly. Validate env at startup; no console.log; strict TypeScript; production-safe errors.
