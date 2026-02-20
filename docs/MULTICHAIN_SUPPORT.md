# Multi-Chain Support

Token Unlock Intelligence MCP supports multiple chains in parallel with per-chain sell-pressure intelligence.

## Chain provider factory

- **chainProviderFactory.ts**: `getChainProvider(chainId | chainName)` returns EthereumRpcProvider / ArbitrumRpcProvider / BscRpcProvider or Mock.
- Config: **data/chains.json** or ENV (`ETH_RPC_URL`, `ARB_RPC_URL`, `BSC_RPC_URL`).

## DB: chain_id

- **unlock_schedules**, **unlock_events**, **vesting_analysis**, **unlock_flow_analysis**, **cluster_flow_aggregation** all have **chain_id**.
- Migration: **sql/migration_multichain.sql**.
- Queries: `WHERE token_symbol = $1 AND chain_id = $2`.

## Registry and loader

- **unlockRegistry.json** entries can set **chain_id** (default ethereum).
- **registerUnlockSchedule** and **listUnlockSchedules** are chain-aware; **getScheduleByToken(tokenSymbol, chainId?)** supports optional chain.

## Verifier and flow

- **verifyUnlocksOnChain()** with no args uses **getChainProvider(schedule.chain_id)** per schedule. Pass a single ChainProvider for legacy (one chain).
- **UnlockFlow.chain_id** and all flow/aggregation queries are chain-scoped.

## Sellable supply and scoring

- **computeSellableSupply(tokenSymbol, avg30dVolumeUsd?, chainId?)** – optional **chainId** for per-chain supply; omit to aggregate across chains.
- **IntelligenceReport** can include **chains** and **combined_score** for multi-chain aggregation.

## Safety

- Deterministic per chain; reorg depth per provider; no double-counting when aggregating by chain_id.
