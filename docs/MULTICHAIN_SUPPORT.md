# Multi-Chain Support

Token Unlock Intelligence MCP supports multiple chains in parallel with per-chain sell-pressure intelligence.

## Consistent defaults

- **chainId** defaults to **ethereum** wherever optional (e.g. `getScheduleByToken(symbol)`, `getVestingAnalysis(token, contract)`, `updateLastVerifiedBlock(..., chainId?)`).
- When **chainId is omitted** for aggregate APIs:
  - **computeSellableSupply(tokenSymbol, volume?, chainId?)** – aggregates across all chains (events and vesting summed by chain_id); no double-count; deterministic.
  - **getVestingAnalysisByToken(tokenSymbol, chainId?)** – when omitted, returns one row with summed `expected_vested`, `claimed_amount`, `remaining_locked` across all chains (and max `next_unlock_estimate`).
- Schedules or events missing **chain_id** in DB are treated as **ethereum** (`COALESCE(chain_id, 'ethereum')` / `schedule.chain_id ?? 'ethereum'`) so there is no undefined behavior.

## Chain provider factory

- **chainProviderFactory.ts**: `getChainProvider(chainId | chainName)` returns EthereumRpcProvider / ArbitrumRpcProvider / BscRpcProvider or Mock.
- Config: **data/chains.json** or ENV (`ETH_RPC_URL`, `ARB_RPC_URL`, `BSC_RPC_URL`).
- **Caching**: 5 min TTL per chain config; provider instances cached per chain.
- **Batching**: RPC batches >5000 blocks (adaptive down to 500 on errors); **rate limiting**: 100 ms per batch per provider.

## DB: chain_id

- **unlock_schedules**, **unlock_events**, **vesting_analysis**, **unlock_flow_analysis**, **cluster_flow_aggregation** all have **chain_id**.
- Migration: **sql/migration_multichain.sql**.
- **Migration safety**: New columns use `DEFAULT 'ethereum'` so existing rows get a value; no backfill required before NOT NULL. UNIQUE/PRIMARY KEY changes use `DROP CONSTRAINT IF EXISTS <name>`; if your DB uses different constraint names, adjust the migration.
- Queries: `WHERE token_symbol = $1 AND chain_id = $2`.

## Registry and loader

- **unlockRegistry.json** entries can set **chain_id** (default ethereum).
- **registerUnlockSchedule** and **listUnlockSchedules** are chain-aware; **getScheduleByToken(tokenSymbol, chainId?)** defaults to ethereum when chainId omitted.
- **getChainIdsForToken(tokenSymbol)** returns distinct chain_ids for that token (from events + schedules) for per-chain reporting.

## Verifier and flow

- **verifyUnlocksOnChain()** with no args uses **getChainProvider(schedule.chain_id)** per schedule. Pass a single ChainProvider for legacy (one chain).
- **Concurrency**: Schedules are processed **sequentially** to avoid DB write races. Each chain provider applies its own rate limiting (e.g. 100 ms per batch). **analyzeUnlockFlow** is invoked per event (sequentially in the pipeline); chain_id is taken from the event, so per-chain writes do not race.
- **UnlockFlow.chain_id** and all flow/aggregation queries are chain-scoped.

## Sellable supply and scoring

- **computeSellableSupply(tokenSymbol, avg30dVolumeUsd?, chainId?)** – optional **chainId** for per-chain supply; omit to **aggregate across all chains** (deterministic, no double-count).
- **IntelligenceReport** can include **chains** (per-chain breakdown) and **combined_score** (aggregate weighted score).

### Combined score (aggregation formula)

- **combined_score** is a weighted average of per-chain **score_numeric** so that small L2 unlocks do not skew the overall score:
  - For each chain with activity: compute per-chain supply and **score_numeric**.
  - **Weight per chain**: \(w_c = \max(\text{real\_sellable\_supply}_c,\, \text{claimed\_amount}_c,\, 1)\).
  - **Formula**: \(\text{combined\_score} = \round\left(\frac{\sum_c (\text{score}_c \cdot w_c)}{\sum_c w_c}\right)\), clamped to \([0, 100]\).
  - If only one chain (or only ethereum), **combined_score** equals that chain’s score; no change for single-chain tokens.

## ExchangeRegistry

- **getExchangeInfo(address, chainId?)** accepts optional **chainId** for future per-chain labels/clusters. Current behavior is global (same mapping for all chains).

## Example report

- **docs/example_multichain_report.json** – sample IntelligenceReport with **chains** (ethereum, arbitrum) and **combined_score** (weighted by unlock size). Top-level **sellable_supply** is aggregated across chains.

## Safety

- Deterministic per chain; reorg depth per provider; no double-counting when aggregating by chain_id. Idempotent results when re-running with same data.
