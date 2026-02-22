# Multi-Chain Tokenomics Risk Intelligence Engine — Architecture

## 1. Engine architecture layout

The engine is a **deterministic, multi-chain, probabilistic token supply risk** system. It supports **any ERC-20/BEP-20** on Ethereum, Arbitrum, and BSC without a static token registry.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  MCP JSON-RPC (analyze_token_supply_risk)                                   │
│  Flat result • No success/data wrapper • -32000 on unresolvable • -32603 on │
│  validation failure                                                         │
└─────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Tool: runAnalyzeTokenSupplyRisk                                            │
│  • Canonical cache key (token_symbol + token_address + chain + timeframe +  │
│    simulation_params) → TTL 10 min (5–15 min bounds)                        │
│  • Cache hit → return identical cached flat result                          │
│  • Dynamic path: token_address + chain → runDynamicSupplyEngine (8s timeout)│
│  • Registry path: token_symbol only → registry + mapRegistryResultToFlat    │
│  • Add engine_latency_ms (dynamic path only), result_integrity_hash (SHA256 │
│    of result excluding hash field)                                          │
└─────────────────────────────────────────────────────────────────────────────┘
         │                                              │
         ▼                                              ▼
┌────────────────────────────┐            ┌────────────────────────────────────┐
│  Dynamic supply engine     │            │  Registry path                     │
│  (src/services/            │            │  Unlock registry, market data,     │
│   dynamicSupply/)          │            │ vesting/emission/liquidity/risk    │
│  • Discovery: supply +     │            │ analyzers → mapRegistryResultToFlat│
│    decimals, symbol, name  │            │  (same flat shape + new fields)    │
│  • Supply cache (15 min)   │            └────────────────────────────────────┘
│  • Block number + timestamp│
│  • Volume fusion, depth,   │
│    concentration, risk     │
│    curve, shock sim        │
└────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Core analytics (src/core/quantitativeAnalytics.ts)                         │
│  Uncertainty, volume fusion, concentration, liquidity depth, emission       │
│  acceleration, shock simulation, risk flags, risk tier, pressure class,     │
│  unlock pattern, supply volatility, data quality                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Service module structure

| Module | Role |
|--------|------|
| **src/services/dynamicSupply/erc20ChainReader.ts** | `readErc20Supply`, `readErc20Metadata` (symbol/name), `discoverToken` (batched). No ABI; selectors only. |
| **src/services/dynamicSupply/supplyCache.ts** | In-memory supply snapshots; TTL 15 min; `getSupplyFromCacheWithTimestamp` for freshness. |
| **src/services/dynamicSupply/supplyRiskResultCache.ts** | Deterministic result cache: stable canonical key, TTL 10 min (5–15), max 300 entries. |
| **src/services/dynamicSupply/dynamicSupplyEngine.ts** | Runs dynamic path: discovery → supply + block freshness → volume fusion, concentration, depth, risk curve, shock sim, flags, tier. Returns flat shape. |
| **src/core/quantitativeAnalytics.ts** | Model metadata, data freshness, data quality, risk flags, risk tier, pressure classification, unlock pattern, concentration risk (top + treasury + max unlock), supply volatility index, forward risk with uncertainty, volume fusion, liquidity depth, emission acceleration, shock simulation. |
| **src/core/resultIntegrity.ts** | SHA256 of stable JSON (result excluding `result_integrity_hash`). |
| **src/tools/analyze_token_supply_risk.ts** | Orchestrates cache, dynamic vs registry path, engine_latency_ms, result_integrity_hash, flat output. |
| **src/api/registerMcpRoute.ts** | MCP handler; outputSchema; `isValidSupplyRiskResult` runtime guard; jsonRpcError(-32603) on validation failure. |

---

## 3. Output schema (flat)

All fields present; numbers finite; risk scores 0–100; null only where allowed.

- **model_metadata**: model_version, analytics_layer, build_timestamp  
- **data_freshness**: supply_snapshot_timestamp, volume_snapshot_timestamp, last_rpc_block_number, block_number_used, block_timestamp_used  
- **inflation_rate_30d**, **inflation_rate_90d**, **supply_volatility_index**  
- **emission_trend**, **unlock_pressure_ratio**, **unlock_pressure_classification** (LOW | MODERATE | HIGH | EXTREME), **fused_volume_30d_usd**  
- **liquidity_stress_score**, **cliff_detected**, **cliff_size_percent**, **next_estimated_unlock_timestamp** (number | null), **unlock_pattern_type** (linear | burst | unknown)  
- **forward_risk_curve**: risk_30d, risk_90d, risk_180d, confidence_interval_low, confidence_interval_high, model_confidence_score  
- **volume_source_consistency_score**, **top_holder_concentration_score**, **treasury_exposure_score**, **max_single_unlock_risk**  
- **liquidity_depth_profile**: impact_1pct, impact_3pct, impact_5pct  
- **emission_acceleration_score**, **simulation_outcome** (object | null), **risk_flags**, **risk_tier**  
- **result_integrity_hash**, **engine_latency_ms**, **data_quality_score**
- **historical_depth_limited** (boolean), **holder_data_confidence_score** (0–100), **combined_volatility_index** (0–100), **pattern_confidence_score** (0–100), **analysis_scope** ("dynamic" | "registry" | "hybrid")

---

## 4. Rolling 90d inflation and depth flag

- **Replaces** the previous synthetic `inflation_90d = inflation_30d * 3`.
- **When ≥90 days of supply history** (event timestamps span 90+ days): three 30-day windows are used — t−90→t−60, t−60→t−30, t−30→t (t = frozen execution time; see §8a). Inflation % per window = (sum of unlock amounts in window) / circulating supply × 100. **inflation_90d** = weighted mean of the three window rates with weights **[0.2, 0.3, 0.5]** (more weight to recent).
- **When only 60 days available**: two windows (t−60→t−30, t−30→t) with weights **[0.4, 0.6]**; **historical_depth_limited** = true.
- **When &lt;60 days**: fallback to scaled estimate (e.g. inflation_30d × 3) and **historical_depth_limited** = true.
- **historical_depth_limited** is always set accordingly and exposed in the flat result. Computation is deterministic for the same event set within cache TTL.

---

## 5. Holder data confidence (transparency metadata)

- **holder_data_confidence_score (0–100)** indicates how reliable the holder/concentration inputs are. It does **not** change existing concentration scores.
- **Real holder breakdown**: 90–100 (e.g. 95).
- **Treasury inference only** (registry vesting): 50–70 (e.g. 60).
- **Purely heuristic** (dynamic path, no unlock registry): 20–40 (e.g. 30).
- Deterministic per data path; no change to top_holder_concentration_score, treasury_exposure_score, or max_single_unlock_risk.

---

## 6. Combined volatility index

- **supply_volatility_index** is unchanged: inflation-only, std(inflation_rates) normalized 0–100 (backward compatible).
- **combined_volatility_index** = 0.5 × inflation_volatility + 0.3 × volume_volatility + 0.2 × liquidity_depth_volatility. Each component is std of the respective series (inflation rates, volume windows, depth metrics) normalized to 0–100; missing series contribute 0. Both indices are validated and clamped 0–100. Deterministic for same inputs.

---

## 7. Pattern confidence score

- **pattern_confidence_score (0–100)** reflects confidence in **unlock_pattern_type** (linear | burst | unknown).
- **≥5 windows** of data: high confidence (80–100).
- **3–4 windows**: medium (50–80).
- **&lt;3 windows**: low (20–50).
- Confidence is reduced if coefficient of variation of unlock amounts is very high (e.g. CV &gt; 1.5). Clamped 0–100; deterministic.

---

## 8. Analysis scope indicator

- **analysis_scope**: `"dynamic"` | `"registry"` | `"hybrid"`.
- **dynamic**: result produced from the token_address path (dynamic supply engine only).
- **registry**: result produced from the static registry path (symbol + registry + market data).
- **hybrid**: when dynamic and registry data are merged in a single result (if implemented). Exposed in flat result for transparency.

---

## 8a. Execution time freezing for deterministic windowing

- **Why executionNowMs is frozen**: Rolling windows (e.g. t−90→t−60, t−60→t−30, t−30→t) must use a single reference time for bucket boundaries. If `Date.now()` is read in multiple places, boundaries can drift by milliseconds between calls and change which window an event falls into, causing non-deterministic classification and volatility across runs.
- **Implementation**: At the start of each tool execution (after cache miss), the engine sets `executionNowMs = Date.now()` once. This value is passed into the dynamic engine and into the registry path. All time-based logic uses it: window bucketing in `computeWindowInflationRates(executionNowMs, ...)`, supply/volume snapshot timestamps, and `buildDataFreshness(..., nowSec)`. Timeout checks still use real time so the 8s limit is enforced.
- **Not cached**: `executionNowMs` is not part of the cache key or stored in the result; it is per-execution. Within one execution, every window calculation and timestamp derives from the same frozen value, so identical inputs in that run yield identical buckets, rolling inflation, and risk output.

---

## 8b. Dynamic volatility weight normalization

- **Why weights normalize**: Combined volatility uses base weights (inflation 0.5, volume 0.3, depth 0.2). If volume or depth data is missing (e.g. volume_windows_count &lt; 2 or no depth metrics), applying the fixed formula would treat the missing component as zero and effectively suppress the index, understating volatility.
- **Implementation**: In `computeCombinedVolatilityIndex`, only **available** components are included: inflation (when inflation rates exist), volume (when ≥2 volume windows), depth (when ≥2 depth metrics). The base weights of the available components are summed and each component’s weight is normalized by this sum. `combined_volatility_index` = sum(component_value × normalized_weight) for available components, then clamped 0–100. If no component is available, the index is 0.
- **Why this avoids volatility underestimation**: When only inflation is present, the index equals the inflation-only volatility (weight 1). When inflation and volume are present, weights 0.5 and 0.3 are renormalized to sum to 1 (e.g. 5/8 and 3/8), so the index reflects both dimensions without being diluted by a missing depth term. Same for inflation+depth or all three. No partial weights are applied without normalization, so the result is always a convex combination of available components and remains comparable across data availability.

---

## 9. Deterministic cache integration

- **Key**: `canonicalCacheKey(params)` = stable stringify of `{ token_symbol, token_address, chain, timeframe_days, simulation_params }` (sorted keys).  
- **TTL**: 10 minutes (clamped 5–15 min).  
- **Guarantee**: Same request within TTL returns identical flat result (scores, intervals, metadata, integrity hash).  
- **Storage**: In-memory Map; FIFO eviction at max 300 entries.

---

## 10. Risk scoring formulas

- **Liquidity stress score (0–100)**  
  Piecewise in unlock_pressure_ratio (≥1 → +50, ≥0.5 → +35, ≥0.1 → +20), inflation (>5% → +25, >1% → +15), cliff % (>5% → +25, >1% → +10). Sum clamped 0–100.

- **Unlock pressure classification**  
  ratio = projected_new_supply_30d / fused_volume_30d:  
  LOW &lt; 0.1, MODERATE 0.1–0.5, HIGH 0.5–1, EXTREME &gt; 1.

- **Risk tier**  
  From liquidity_stress_score: 0–25 LOW, 26–50 MODERATE, 51–75 HIGH, 76–100 EXTREME.

- **Forward risk curve**  
  risk_30d/90d/180d from liquidity and horizon scaling. confidence_interval_low/high = min/max of curve ± spread (spread = 5 + volatilityHint×15). model_confidence_score = dataQuality×(1 − (unlockVariance + volumeVariance)/2×0.5), clamped 0–100.

- **Concentration (0–100)**  
  top_holder_concentration_score, treasury_exposure_score, max_single_unlock_risk from treasury % and max single unlock % with linear scaling and clamp.

- **Supply volatility index (0–100)**  
  Inflation-only: standard deviation of inflation rates (e.g. 30d, 90d) normalized (std×10, cap 100). Kept for backward compatibility.

- **Combined volatility index (0–100)**  
  See section 6 and section 8b: weighted combination of inflation, volume, and liquidity depth volatility (each normalized 0–100), with dynamic weight normalization so that when volume or depth is missing, weights are renormalized over available components only.

- **Data quality score (0–100)**  
  Volume source count (2+ → 40, 1 → 25, 0 → 10), unlock history depth (12+ → 35, 6+ → 25, 1+ → 15, 0 → 5), supply completeness (1 → 25, 0.5 → 15, else 5). Sum clamped 0–100.

- **Liquidity depth (impact %)**  
  impact = f(sell_size / volume); power-law exponent scales with unlock pressure and concentration. impact_1pct, impact_3pct, impact_5pct for 1%, 3%, 5% supply sell.

---

## 11. Uncertainty methodology

- **Uncertainty in the forward curve**  
  - **Spread**: confidence_interval_low/high = min(risk_30d, risk_90d, risk_180d) − spread and max + spread, with spread = 5 + volatilityHint×15 (volatilityHint 0–1).  
  - **model_confidence_score**: base = dataQuality (0–1). Penalty from unlock and volume variance: qualityAdjusted = dataQuality × (1 − (unlockVariance + volumeVariance)/2 × 0.5). Normalized to 0–100.  
  - Unlock variance: from time-series of unlock amounts (e.g. coefficient of variation or normalized variance).  
  - Volume variance: 1 − volume_source_consistency_score/100 (consistency from coefficient of variation across volume sources).

- **Determinism**  
  Same inputs and cache state produce the same spread, same model_confidence_score, and same confidence_interval_low/high within the TTL window.

---

## 12. Performance guards

- **Dynamic path**: Hard timeout 8 seconds; on timeout return defaulted flat result (no throw to MCP; tool returns structured error for non-cache path).  
- **RPC**: Batched eth_call (totalSupply, decimals, symbol, name); single getLatestBlockNumber + getBlock for freshness. No full-chain scan.  
- **Supply snapshot**: Cached 15 min; result cache 10 min to avoid repeated engine runs.

---

## 13. Validation and safety

- **Before jsonRpcSuccess**: `isValidSupplyRiskResult(result)` ensures every numeric field is finite, all risk and score fields in 0–100, required strings/arrays/objects present, next_estimated_unlock_timestamp number | null, simulation_outcome object | null, **historical_depth_limited** boolean, **holder_data_confidence_score** / **combined_volatility_index** / **pattern_confidence_score** in 0–100, **analysis_scope** one of "dynamic" | "registry" | "hybrid".  
- **On failure**: `jsonRpcError(id, -32603, "Internal result validation failed.")`.  
- **No NaN/undefined**: All numbers from analytics and engine go through `fin`/`clamp`/`toNum`/`sanitizeNum`; hash and latency set with fallbacks.
