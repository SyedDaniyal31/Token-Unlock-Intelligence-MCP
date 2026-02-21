# Token Unlock Intelligence MCP

MCP server that analyzes token unlocks and sell-pressure risk: canonical registry → on-chain verification → exchange flow → vesting intelligence → impact scoring. Supports multiple chains (Ethereum, Arbitrum, BSC) with weighted combined scores.

## Features

- **Canonical unlock registry** — `data/unlockRegistry.json` synced to Postgres; no hardcoded schedules.
- **On-chain verification** — RPC-based (getLogs, getBlock, getTokenTransfers); batched, rate-limited, reorg-safe.
- **Exchange flow** — Labels and clusters; high-velocity and retained vs sellable supply.
- **Vesting intelligence** — Contract-type detection, expected_vested, next_unlock_estimate, predictive metrics.
- **Impact scoring** — Weighted formula (unlock %, liquidity ratio, exchange flow, behavior); primary_driver, sell_pressure_estimate.
- **Multi-chain** — Optional `chainId` (default ethereum); per-chain breakdown and weighted `combined_score`.
- **MCP tool** — `analyze_token_unlock` (token_symbol) and REST `POST /intelligence`.

## Quick start

```bash
npm install
cp .env.example .env   # set DATABASE_URL, optional RPC_URL and COINGECKO_API_KEY
npm run build
npm start
```

- **Database:** Postgres. Migrations run automatically on startup (no manual `psql`).
- **Start:** `npm start` runs `node dist/index.js` (migrations → sync registry → HTTP server).
- **Dev:** `npm run dev` uses ts-node.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | **Yes** | PostgreSQL connection string. |
| `RPC_URL` | Yes in production | Ethereum RPC (e.g. Infura, Alchemy). Omit in dev for mock provider. |
| `NODE_ENV` | Recommended | `production` on Railway. |
| `PORT` | Optional | Default 3000; Railway sets automatically. |
| `COINGECKO_API_KEY` | Optional | Market data; omit for stub (zeros). |
| `ARB_RPC_URL` | Optional | Arbitrum RPC (multi-chain). |
| `BSC_RPC_URL` | Optional | BSC RPC (multi-chain). |
| `LOG_LEVEL` | Optional | `info`, `debug`, `warn`, `error`. |

## Deployment (Railway)

1. **Variables:** Set `DATABASE_URL`, `RPC_URL`, `NODE_ENV=production`. Optionally `ARB_RPC_URL`, `BSC_RPC_URL`, `COINGECKO_API_KEY`.
2. **Start command:** `npm run railway:deploy` (runs `npm run build && node dist/index.js`).
3. **Migrations:** Run automatically on startup in a single transaction; idempotent (IF NOT EXISTS). Build copies `sql/` to `dist/sql`.
4. **Health:** `GET /health` returns `{ status, db, chains_configured, uptime_seconds }`. Use for Railway health checks.

Rollback: redeploy a previous revision; migrations are safe to re-run.

## Architecture (layers)

1. **Registry** — `data/unlockRegistry.json` + `syncUnlockRegistryToDb()`; DB tables `unlock_schedules`, `unlock_events`, `unlock_flow_analysis`, `cluster_flow_aggregation`, `vesting_analysis`, `unlock_analysis`.
2. **On-chain** — `verifyUnlocksOnChain()` with `ChainProvider` (Ethereum/Arbitrum/BSC RPC or mock); inserts into `unlock_events`, upserts `vesting_analysis`.
3. **Flow** — `analyzeUnlockFlow(event)` uses `ExchangeRegistry`; exchange vs retained vs high-velocity; cluster aggregation.
4. **Market** — `MarketDataProvider` (CoinGecko or stub); 5 min cache.
5. **Intelligence** — `computeSellableSupply()`, `computeImpactScore()`, `generateUnlockIntelligence()`; report with risk_level, combined_score (multi-chain).
6. **API** — MCP at `/mcp`, `POST /intelligence`, `GET /health`.

## Endpoints

- **GET /health** — `{ status, db, chains_configured, uptime_seconds, timestamp }`.
- **POST /intelligence** — Body: `{ token_symbol: "ARB" }` or `{ query: "..." }`. Returns full `IntelligenceReport`.
- **POST /mcp** — JSON-RPC; tool `analyze_token_unlock` with `token_symbol`. Context Protocol middleware may require `Authorization: Bearer <JWT>` for tool calls.

## Test with cURL

```bash
# Health
curl -s http://localhost:3000/health | jq

# Intelligence (REST)
curl -s -X POST http://localhost:3000/intelligence -H "Content-Type: application/json" -d '{"token_symbol":"ARB"}' | jq

# MCP tool call (if auth not required)
curl -s -X POST http://localhost:3000/mcp -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"analyze_token_unlock","arguments":{"token_symbol":"ARB"}}}' | jq
```

## Multi-chain

- **Defaults:** `chainId` defaults to `ethereum` wherever optional.
- **Aggregation:** `computeSellableSupply(symbol, volume)` without `chainId` aggregates across all chains; `getVestingAnalysisByToken(symbol)` without `chainId` returns summed vesting.
- **Report:** `IntelligenceReport.chains` = per-chain breakdown; `combined_score` = weighted average by unlock size so small L2s don’t skew the score.

## Vesting & RPC

- **Vesting:** `vestingDetector` uses optional `ChainProvider.call`; types (linear_vesting, openzeppelin_token_vesting, cliff, generic). `vesting_analysis` holds expected_vested, claimed_amount, next_unlock_estimate; used in sellable supply and scoring.
- **RPC:** `EthereumRpcProvider` uses `RPC_URL`; batches >5000 blocks, 100 ms between batches, reorg-safe cap; implements getLogs, getBlock, getTokenTransfers, call.

## Scripts

- `npm run build` — Compile TypeScript and copy `sql/` to `dist/sql`.
- `npm start` — Run app (migrations + sync + server).
- `npm run railway:deploy` — Build then start (for Railway).
- `npm run dev` — Run with ts-node.

## Data and config

- **Schedules:** Edit `data/unlockRegistry.json`; add `chain_id` (e.g. `arbitrum`) per entry for multi-chain.
- **Chains:** `data/chains.json` or env `ETH_RPC_URL`, `ARB_RPC_URL`, `BSC_RPC_URL`.
- **Exchanges:** `data/exchangeLabels.json` for address → label/cluster.

Example reports: `docs/example_multichain_report.json`, `docs/example_vesting_analysis.json`.
