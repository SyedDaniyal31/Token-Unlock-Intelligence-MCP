# Intelligence Infrastructure Architecture

## 6-Layer Design

1. **Data Sources Layer**  
   Abstract interfaces: `ChainProvider`, `MarketDataProvider`, `ExchangeRegistry`. Implementations live in `infrastructure/` (RPC, market, exchanges). No hardcoded APIs in business logic.

2. **Normalization Layer**  
   All external data is normalized into types in `core/types.ts`: `TokenMetadata`, `UnlockEvent`, `UnlockFlow`, `MarketSnapshot`, `IntelligenceReport`.

3. **On-Chain Verification Layer**  
   `ingestion/unlockVerifier.ts`: accepts a `ChainProvider`, fetches logs, parses to events, persists to `unlock_events`, updates `last_verified_block`. Chain-agnostic; no business logic.

4. **Flow & Behavioral Analysis Layer**  
   `ingestion/flowAnalyzer.ts`: analyzes exchange transfers, wallet retention, basic multi-hop (moved to new wallet), and 24h time-window grouping. Uses `ExchangeRegistry`. Writes to `unlock_flow_analysis`.

5. **Intelligence Scoring Layer**  
   `intelligence/impactScoring.ts`: inputs include % circulating supply, % volume, % to exchanges, liquidity depth multiplier, behavioral multiplier. Returns `{ score, risk_level, explanation }`.  
   `intelligence/sellableSupply.ts`: computes scheduled/claimed/retained/exchange_inflow/real_sellable_supply from `unlock_events` and `unlock_flow_analysis`.

6. **MCP Interface Layer**  
   `api/mcpController.ts`: extracts token from request, calls `generateUnlockIntelligence(token, deps)`, returns structured response. No business logic in the controller.  
   `api/routes.ts`: registers `/health` and `/intelligence`, delegates to controller.

## Brain: Unlock Intelligence Service

`intelligence/unlockIntelligence.ts` — `generateUnlockIntelligence(tokenSymbol, deps)`:

1. Load metadata (unlock registry)
2. Verify latest unlocks (chain provider)
3. Analyze flows (flow analyzer + exchange registry)
4. Compute sellable supply
5. Fetch market snapshot (market provider)
6. Compute impact score
7. Return `IntelligenceReport`

## Orchestration

`orchestration/ingestionPipeline.ts` — `runFullIngestionCycle(deps)`:

- Process all tracked tokens
- Idempotent
- Log per-token failures; never crash the full cycle

## Dependency Injection

- `ChainProvider`, `MarketDataProvider`, `ExchangeRegistry` are created in `app.ts` and passed into the intelligence service, orchestration, and API.
- Enables multi-chain support, smart-money tracking, and exchange liquidity depth to be added later without changing business logic.

## Folder Structure

```
src/
  app.ts
  index.ts
  core/
    types.ts
    config.ts
    logger.ts
  infrastructure/
    database/postgres.ts
    rpc/chainProvider.ts, ethereumProvider.ts
    market/marketProvider.ts
    exchanges/exchangeRegistry.ts
  ingestion/
    unlockRegistry.ts
    unlockVerifier.ts
    flowAnalyzer.ts
  intelligence/
    sellableSupply.ts
    impactScoring.ts
    unlockIntelligence.ts
  orchestration/
    ingestionPipeline.ts
  api/
    mcpController.ts
    routes.ts
```

Existing modules (`broker`, `ingestion/registry`, `ingestion/verification`, `ingestion/flowAnalysis`, `ingestion/pipeline`, `impactEngine`) remain for backward compatibility and are used by the cron precompute path.
