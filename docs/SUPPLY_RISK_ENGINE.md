# Multi-Chain Token Supply Risk Engine

## Folder structure (new/updated)

```
src/
  core/
    supplyAnalyzer.ts      # Supply metrics (total, circulating, allocations, upcoming, 30d volume)
    vestingAnalyzer.ts     # Cliff detection (large unlocks >3%, clustered, next cliff, severity 0-100)
    emissionModel.ts       # Emission pattern (linear, decay, fixed, inflationary, deflationary), inflation, velocity
    liquidityAnalyzer.ts   # Liquidity stress (unlock/volume ratio, 0-100 score, risk level)
    historicalUnlocks.ts   # Historical unlock analysis (events 12m, avg size, % supply per event)
    riskEngine.ts          # Weighted risk score (historical 20%, unlock 25%, cliff 15%, emission 15%, liquidity 25%)
    types.ts               # (existing)
  chains/
    ethereum.ts
    arbitrum.ts
    bsc.ts
    index.ts               # SupportedChainSlug, toChainId, isSupportedChain
  tools/
    analyze_token_supply_risk.ts   # Orchestrator: runAnalyzeTokenSupplyRisk(input, deps)
  api/
    registerMcpRoute.ts    # MCP tool "analyze_token_supply_risk", inputSchema, outputSchema, callTool
  ingestion/
    unlockRegistry.ts      # + getUnlockEventsInRange(token, since, until, chainId?)
```

## Tool registration

- **Name:** `analyze_token_supply_risk`
- **Methods:** `listTools` / `tools/list`, `callTool` / `tools/call`, `initialize`
- **Route:** POST /mcp (JSON-RPC 2.0 envelope, never throws; errors return -32000 with message).

## inputSchema

```json
{
  "type": "object",
  "properties": {
    "token_symbol": { "type": "string", "description": "Token ticker symbol (e.g. ETH, ARB)" },
    "chain": { "type": "string", "enum": ["ethereum", "arbitrum", "bsc"], "description": "Chain to analyze; auto-detect if omitted" },
    "timeframe_days": { "type": "number", "description": "Analysis window in days; default 30" }
  },
  "required": ["token_symbol"]
}
```

Defaults: `chain` = auto-detect from registry; `timeframe_days` = 30.

## outputSchema (matches returned JSON)

Success:

```json
{
  "success": true,
  "data": {
    "token": "string",
    "chain": "string",
    "supply_metrics": { "total_supply", "circulating_supply", "max_supply", "team_allocation_pct", "investor_allocation_pct", "treasury_allocation_pct", "upcoming_unlock_amount", "avg_30d_volume_usd" },
    "historical_unlock_analysis": { "unlock_events_last_12m", "avg_unlock_size", "supply_increase_pct_per_event", "price_reaction_avg_pct", "post_unlock_volatility" },
    "vesting_cliff_analysis": { "large_unlock_count", "clustered_unlocks", "has_cliff", "next_cliff_date", "cliff_severity_score", "max_unlock_pct_supply", "avg_unlock_size" },
    "emission_analysis": { "pattern", "annual_inflation_rate_pct", "supply_growth_30d_pct", "supply_velocity", "supply_change_pct" },
    "liquidity_analysis": { "unlock_to_volume_ratio", "liquidity_stress_score", "liquidity_risk_level", "unlock_value_usd", "volume_30d_avg", "unlock_to_supply_pct" },
    "risk_assessment": { "overall_risk_score", "risk_level", "components": { "historical_score", "unlock_score", "cliff_score", "emission_score", "liquidity_score" } }
  }
}
```

Unsupported token: JSON-RPC error `-32000` with message `"Token not supported on selected chain"` (no success: false in result).

## Risk scoring formula

**Weights (riskEngine.ts):**

- Historical unlock impact: **20%**
- Upcoming unlock size: **25%**
- Cliff severity: **15%**
- Inflation/emission: **15%**
- Liquidity stress: **25%**

**Component derivation:**

- `historical_score`: min(100, unlock_events_last_12m * 5 + supply_increase_pct_per_event * 2)
- `unlock_score`: min(100, unlock_to_supply_pct * 10 + (unlock_to_volume > 0.25 ? 30 : 0))
- `cliff_score`: vesting cliff_severity_score (0–100)
- `emission_score`: min(100, max(0, annual_inflation_rate_pct * 2 + 50))
- `liquidity_score`: liquidity_stress_score from LiquidityStressModel (0–100)

**Overall:** `overall_risk_score = round(0.2*h + 0.25*u + 0.15*c + 0.15*e + 0.25*l)`, clamped 0–100.  
**risk_level:** 0–25 LOW, 26–50 MODERATE, 51–75 HIGH, 76–100 EXTREME.

## Multi-chain support

- **Chains:** Ethereum, Arbitrum, BSC (chain_id in DB: ethereum, arbitrum, bsc or bnb).
- **Resolution:** If `chain` omitted, first chain from registry for the token is used. If `chain` = "bsc", DB chain_id "bsc" or "bnb" is used.
- **Data:** getScheduleByToken(symbol, dbChainId), getUnlockEventsInRange(symbol, since, until, dbChainId), computeSellableSupply(symbol, volume, dbChainId).

## JSON-RPC and Context

- All responses: `{ jsonrpc: "2.0", id, result }` or `{ jsonrpc: "2.0", id, error: { code, message } }`.
- HTTP 200 for valid JSON-RPC; tool failures use -32000, never raw throws.
- outputSchema matches returned success shape; no undefined fields; numeric fields are numbers; deterministic.
