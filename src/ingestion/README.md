# Premium Unlock Ingestion (3-Layer Pipeline)

## Architecture

1. **Layer 1 — Unlock Metadata Registry** (`unlock_schedules`)  
   Canonical schedule per token/contract. `registerUnlockSchedule()` upserts by `(token_symbol, contract_address)`.

2. **Layer 2 — On-Chain Verification** (`unlock_events`)  
   `verifyUnlocksOnChain()` uses a `ChainProvider` (getLogs, getBlock) to fetch vest/claim/transfer events and persist them. Chain-agnostic; replace `MockChainProvider` with a real RPC wrapper.

3. **Layer 3 — Sellable Supply** (`unlock_flow_analysis`)  
   `analyzeUnlockFlow(event)` classifies each event: exchange transfer → high risk, retained → low, moved → moderate. `computeRealSellableSupply(token_symbol)` aggregates claimed vs sellable (last 30d) for impact scoring.

## Orchestrator

`runUnlockIngestionPipeline()` runs in order: verify → analyze new events → compute sellable per token → upsert `unlock_analysis`. Idempotent; per-token errors are logged and do not stop the run.

## Extensibility

- **ChainProvider**: Implement `getLogs(contract, fromBlock, toBlock)` and `getBlock(number)`; set via `setDefaultChainProvider(provider)`.
- **Event parsing**: In `verification.ts`, replace `parseLogsToEvents()` with ABI-based decoding and set `recipient_address` when available.
- **Exchange list**: Extend `exchangeAddresses.ts` (DB or config) and `getExchangeLabel()` for risk copy.
- **Cohort / volume**: Pipeline currently writes sellable metrics; feed `computeImpactScore()` with volume and cohort from registry or external source.

## DB

Run `sql/schema_unlock_ingestion.sql` and ensure `unlock_analysis` has `UNIQUE(token_symbol)` for upserts.
