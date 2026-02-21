# Railway Deployment

Token Unlock Intelligence MCP is ready for production on Railway with automatic Postgres migrations and bootstrap.

## Required environment variables

Set these in **Railway → Your Service → Variables** (or use a linked Postgres service):

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | **Yes** | PostgreSQL connection string. If you add a Postgres plugin, use its `DATABASE_URL` or `DATABASE_PUBLIC_URL` and assign it to **DATABASE_URL** for this service. |
| `RPC_URL` | **Yes** (production) | Ethereum RPC URL (e.g. Infura, Alchemy). Required when `NODE_ENV=production`. |
| `NODE_ENV` | Recommended | Set to `production` on Railway. |
| `PORT` | Optional | Railway sets this automatically; default 3000 if missing. |
| `ARB_RPC_URL` | Optional | Arbitrum RPC for multi-chain. |
| `BSC_RPC_URL` | Optional | BSC RPC for multi-chain. |
| `COINGECKO_API_KEY` | Optional | For market data (otherwise stub data). |
| `LOG_LEVEL` | Optional | `info` (default), `debug`, `warn`, `error`. |

**Important:** The app reads **only `DATABASE_URL`** for the database. If your Postgres plugin exposes `DATABASE_PUBLIC_URL`, set `DATABASE_URL` to that value (e.g. via Railway variable reference).

## Start command

Use:

```bash
npm run railway:deploy
```

This runs `npm run build && node dist/index.js`: build TypeScript then start the server. The server entrypoint is `dist/index.js` (built from `src/index.ts`).

## Automatic migrations on startup

1. **Order:** On every startup, before the HTTP server listens, the app runs migrations in this order:
   - `sql/schema_unlock_ingestion.sql` – base tables (unlock_schedules, unlock_events, unlock_flow_analysis)
   - `sql/schema_unlock_analysis.sql` – unlock_analysis table
   - `sql/migration_cluster_flow_engine.sql` – cluster_flow_aggregation and flow columns
   - `sql/migration_vesting_intelligence.sql` – vesting_analysis and vesting_type
   - `sql/migration_vesting_predictive.sql` – vesting predictive columns
   - `sql/migration_indexes_performance.sql` – performance indexes
   - `sql/migration_multichain.sql` – chain_id on all tables
   - `sql/migration_flow_high_velocity_suspected.sql` – high_velocity and suspected_hot_wallet columns

2. **Behavior:** Migrations run inside a **single transaction**. If any step fails, the transaction is rolled back and the process **exits** (no server start). Objects that already exist (e.g. “already exists”) are treated as idempotent and do not fail the run.

3. **Fresh database:** An empty Postgres database is fully initialized on first start; no manual `psql` or one-off migration commands are required.

## Bootstrap sequence

1. Validate required ENV: in production, `DATABASE_URL` and `RPC_URL` must be set; otherwise the process exits.
2. **Run migrations** (see above). On failure: log CRITICAL and exit.
3. **Sync registry:** `syncUnlockRegistryToDb()` loads `data/unlockRegistry.json` into `unlock_schedules`. If this fails, the app logs a warning and continues (sync is retried on the next cron run).
4. Start HTTP server and MCP; on first listen, an initial ingestion cycle (verify → flow analysis → precompute) runs.

## Health check endpoint

Railway can use this for health checks and restarts:

- **GET /health**

Response shape:

```json
{
  "status": "ok",
  "db": "connected",
  "chains_configured": ["ethereum", "arbitrum"],
  "uptime_seconds": 123,
  "timestamp": "2025-02-19T12:00:00.000Z"
}
```

- `status`: `"ok"` when DB is connected, `"degraded"` when DB check fails.
- `db`: `"connected"` or `"error"` (from a live `SELECT 1` against Postgres).
- `chains_configured`: chain keys from config / ENV (e.g. ethereum, arbitrum, bsc).
- `uptime_seconds`: process uptime in seconds.

Configure Railway’s health check to call `GET /health` (and optionally treat non-200 or `status !== "ok"` as unhealthy).

## Rollback strategy

- **Schema:** Migrations are additive (new tables, new columns, new indexes). There is no automatic downgrade. To roll back schema changes, restore a DB backup or run manual `ALTER`/`DROP` scripts.
- **App rollback:** Redeploy a previous image/revision in Railway. The same migrations will run again; idempotent steps (e.g. “already exists”) will not fail, so re-deploying is safe.
- **Data:** Rely on Railway/Postgres backups; the app does not perform data backups.

## Running locally

1. **Environment:** Copy `.env.example` to `.env` and set at least:
   - `DATABASE_URL` – local Postgres URL.
   - `RPC_URL` – (optional for dev) Ethereum RPC; if missing, a mock provider is used.

2. **Database:** Start Postgres and run nothing manually; the app will run migrations on start.

3. **Commands:**
   - `npm run build` – compile TypeScript.
   - `npm start` – run `node dist/index.js` (migrations + sync + server).
   - `npm run railway:deploy` – same as `npm run build && npm start` (Railway-style).
   - `npm run dev` – run with ts-node for development.

4. **Endpoints:** After start, you get MCP at `/mcp`, intelligence at `POST /intelligence`, and health at `GET /health`.

## Production safety

- Migrations use `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` / `DROP CONSTRAINT IF EXISTS` where applicable so re-runs do not create duplicate objects or crash.
- No secrets are logged at startup; only non-sensitive env (e.g. `NODE_ENV`, presence of `DATABASE_URL`) can be logged.
- Multi-chain support and deterministic behavior are unchanged; optional `chainId` still defaults to `ethereum` where applicable.
