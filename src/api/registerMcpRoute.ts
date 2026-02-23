/**
 * Production MCP JSON-RPC handler for POST /mcp.
 * Context Protocol compliant: listTools, callTool (tools/list, tools/call).
 * Returns -32603 when result validation fails (internal error); uses -32000 for
 * unresolvable/operational failures (e.g. timeout, token not supported).
 */

import type { Request, Response } from "express";
import type { RequestHandler } from "express";
import type { UnlockIntelligenceDeps } from "../intelligence/unlockIntelligence.js";
import { getIntelligenceReport } from "./mcpController.js";
import { getScheduleByTokenCaseInsensitive } from "../ingestion/unlockRegistry.js";
import { resolveTokenBySymbol, createUnlockTokenRegistry } from "../utils/tokenResolver.js";
import {
  runAnalyzeTokenSupplyRisk,
  buildSoftFailureSupplyRisk,
  type SupplyRiskOutputFlat,
} from "../tools/analyze_token_supply_risk.js";
import { fetchCoinGeckoData } from "../services/marketData/coingeckoClient.js";
import logger from "../core/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcErrorBody {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const UNLOCK_TOOL_NAME = "analyze_token_unlock";
const SUPPLY_RISK_TOOL_NAME = "analyze_token_supply_risk";

const UNLOCK_OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    unlock_pressure_ratio: { type: "number" as const },
    volume_impact_ratio: { type: "number" as const },
    supply_inflation_percent: { type: "number" as const },
    risk_score: { type: "number" as const },
  },
  required: [
    "unlock_pressure_ratio",
    "volume_impact_ratio",
    "supply_inflation_percent",
    "risk_score",
  ] as const,
};

const MCP_TOOLS = [
  {
    name: UNLOCK_TOOL_NAME,
    description:
      "Analyze upcoming token unlock and quantify sell-pressure risk using liquidity-adjusted impact scoring.",
    inputSchema: {
      type: "object" as const,
      properties: {
        token_symbol: { type: "string" as const, description: "Token ticker symbol (e.g. ETH, ARB)" },
      },
      required: ["token_symbol"] as const,
    },
    outputSchema: UNLOCK_OUTPUT_SCHEMA,
  },
  {
    name: SUPPLY_RISK_TOOL_NAME,
    description:
      "Multi-chain token supply risk engine: historical unlocks, vesting cliffs, emission patterns, liquidity stress for Ethereum, Arbitrum, BSC.",
    inputSchema: {
      type: "object" as const,
      properties: {
        token_symbol: { type: "string" as const, description: "Token ticker for registry analysis (e.g. ETH, ARB). Omit when using token_address + chain for dynamic analysis." },
        token_address: { type: "string" as const, description: "Contract address for dynamic analysis (use with chain)" },
        chain: {
          type: "string" as const,
          enum: ["ethereum", "arbitrum", "bsc"] as const,
          description: "Chain to analyze; required when using token_address",
        },
        timeframe_days: { type: "number" as const, description: "Analysis window in days; default 30" },
        simulation_params: {
          type: "object" as const,
          description: "Optional: run market shock simulation (price_shock_pct, volume_shock_pct, unlock_multiplier)",
        },
      },
      required: [] as const,
      description: "Provide token_symbol for registry analysis, or token_address + chain for dynamic analysis. At least one of (token_symbol) or (token_address and chain) is required.",
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        model_metadata: {
          type: "object" as const,
          properties: {
            model_version: { type: "string" as const },
            analytics_layer: { type: "string" as const },
            build_timestamp: { type: "number" as const },
          },
          required: ["model_version", "analytics_layer", "build_timestamp"] as const,
        },
        data_freshness: {
          type: "object" as const,
          properties: {
            supply_snapshot_timestamp: { type: "number" as const },
            volume_snapshot_timestamp: { type: "number" as const },
            last_rpc_block_number: { type: "number" as const },
            block_number_used: { type: "number" as const },
            block_timestamp_used: { type: "number" as const },
          },
          required: ["supply_snapshot_timestamp", "volume_snapshot_timestamp", "last_rpc_block_number", "block_number_used", "block_timestamp_used"] as const,
        },
        inflation_rate_30d: { type: "number" as const },
        inflation_rate_90d: { type: "number" as const },
        supply_volatility_index: { type: "number" as const },
        emission_trend: { type: "number" as const },
        unlock_pressure_ratio: { type: "number" as const },
        unlock_pressure_classification: { type: "string" as const },
        fused_volume_30d_usd: { type: "number" as const },
        liquidity_stress_score: { type: "number" as const },
        cliff_detected: { type: "boolean" as const },
        cliff_size_percent: { type: "number" as const },
        next_estimated_unlock_timestamp: { type: ["number", "null"] as const },
        unlock_pattern_type: { type: "string" as const },
        forward_risk_curve: {
          type: "object" as const,
          properties: {
            risk_30d: { type: "number" as const },
            risk_90d: { type: "number" as const },
            risk_180d: { type: "number" as const },
            confidence_interval_low: { type: "number" as const },
            confidence_interval_high: { type: "number" as const },
            model_confidence_score: { type: "number" as const },
          },
          required: ["risk_30d", "risk_90d", "risk_180d", "confidence_interval_low", "confidence_interval_high", "model_confidence_score"] as const,
        },
        volume_source_consistency_score: { type: "number" as const },
        top_holder_concentration_score: { type: "number" as const },
        treasury_exposure_score: { type: "number" as const },
        max_single_unlock_risk: { type: "number" as const },
        liquidity_depth_profile: {
          type: "object" as const,
          properties: {
            impact_1pct: { type: "number" as const },
            impact_3pct: { type: "number" as const },
            impact_5pct: { type: "number" as const },
          },
          required: ["impact_1pct", "impact_3pct", "impact_5pct"] as const,
        },
        emission_acceleration_score: { type: "number" as const },
        simulation_outcome: { type: ["object", "null"] as const },
        risk_flags: { type: "array" as const, items: { type: "string" as const } },
        risk_tier: { type: "string" as const },
        result_integrity_hash: { type: "string" as const },
        engine_latency_ms: { type: "number" as const },
        data_quality_score: { type: "number" as const },
        historical_depth_limited: { type: "boolean" as const },
        holder_data_confidence_score: { type: "number" as const },
        combined_volatility_index: { type: "number" as const },
        pattern_confidence_score: { type: "number" as const },
        analysis_scope: { type: "string" as const, enum: ["dynamic", "registry", "hybrid"] as const },
        search_exhausted: {
          type: "boolean" as const,
          description: "True when all data sources were checked but no records were found.",
        },
        records_found: {
          type: "number" as const,
          description: "Number of unlock or risk records discovered.",
        },
        no_results_reason: {
          type: "string" as const,
          description: "Machine-readable reason explaining why no data was found.",
        },
        coverage: {
          type: "object" as const,
          properties: {
            registry_checked: { type: "boolean" as const },
            dynamic_checked: { type: "boolean" as const },
            records_found: { type: "number" as const },
          },
          required: ["registry_checked", "dynamic_checked", "records_found"] as const,
        },
        analysis_timestamp: {
          type: "string" as const,
          description: "ISO timestamp when analysis was generated.",
        },
        engine_version: {
          type: "string" as const,
          description: "Version of the supply risk engine used.",
        },
        data_freshness_seconds: {
          type: "number" as const,
          description: "How many seconds old the underlying data is.",
        },
      },
      required: [
        "model_metadata",
        "data_freshness",
        "inflation_rate_30d",
        "inflation_rate_90d",
        "supply_volatility_index",
        "emission_trend",
        "unlock_pressure_ratio",
        "unlock_pressure_classification",
        "fused_volume_30d_usd",
        "liquidity_stress_score",
        "cliff_detected",
        "cliff_size_percent",
        "next_estimated_unlock_timestamp",
        "unlock_pattern_type",
        "forward_risk_curve",
        "volume_source_consistency_score",
        "top_holder_concentration_score",
        "treasury_exposure_score",
        "max_single_unlock_risk",
        "liquidity_depth_profile",
        "emission_acceleration_score",
        "simulation_outcome",
        "risk_flags",
        "risk_tier",
        "result_integrity_hash",
        "engine_latency_ms",
        "data_quality_score",
        "historical_depth_limited",
        "holder_data_confidence_score",
        "combined_volatility_index",
        "pattern_confidence_score",
        "analysis_scope",
        "analysis_timestamp",
        "engine_version",
        "data_freshness_seconds",
      ] as const,
    },
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseBody(raw: unknown): JsonRpcRequest | null {
  if (raw == null) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as JsonRpcRequest;
  return null;
}

function safeSend(res: Response, payload: JsonRpcSuccess | JsonRpcErrorBody): void {
  if (res.headersSent) {
    logger.warn("MCP response already sent; skipping send");
    return;
  }
  res.status(200).set("Content-Type", "application/json").json(payload);
}

function jsonRpcSuccess(id: string | number | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id: string | number | null, code: number, message: string): JsonRpcErrorBody {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** Normalize params.arguments: may be object or JSON string. */
function parseArguments(args: unknown): Record<string, unknown> {
  if (args == null) return {};
  if (typeof args === "object" && !Array.isArray(args)) return args as Record<string, unknown>;
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args) as unknown;
      return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** Defensive normalizer: never return [] to Context; empty/null → soft failure, array of one → unwrap, object → pass through. */
function normalizeSupplyRiskResult(
  maybeResult: unknown,
  id: string | number | null
): JsonRpcSuccess {
  if (
    maybeResult == null ||
    (Array.isArray(maybeResult) && maybeResult.length === 0)
  ) {
    const softFailure = buildSoftFailureSupplyRisk("NO_DATA_RETURNED", 0);
    return jsonRpcSuccess(id, softFailure);
  }
  if (Array.isArray(maybeResult) && maybeResult.length >= 1) {
    const first = maybeResult[0];
    if (first != null && typeof first === "object" && !Array.isArray(first) && "data" in first) {
      return jsonRpcSuccess(id, (first as { data: unknown }).data ?? buildSoftFailureSupplyRisk("EMPTY_ARRAY_GUARD", 0));
    }
    return jsonRpcSuccess(id, first ?? buildSoftFailureSupplyRisk("EMPTY_ARRAY_GUARD", 0));
  }
  if (typeof maybeResult === "object" && !Array.isArray(maybeResult)) {
    return jsonRpcSuccess(id, maybeResult);
  }
  const softFailure = buildSoftFailureSupplyRisk("UNEXPECTED_RESULT_SHAPE", 0);
  return jsonRpcSuccess(id, softFailure);
}

/**
 * Ensure JSON-RPC result is always a flat object for Context (never [], never { success, data }).
 * Call before safeSend so Context receives result: { flat object }.
 */
function ensureFlatResultPayload(
  response: JsonRpcSuccess | JsonRpcErrorBody,
  requestId: string | number | null
): JsonRpcSuccess | JsonRpcErrorBody {
  if (!("result" in response)) return response;
  let r = (response as JsonRpcSuccess).result;
  if (Array.isArray(r)) {
    r = r.length > 0 ? r[0] : null;
    (response as JsonRpcSuccess).result = r ?? buildSoftFailureSupplyRisk("EMPTY_ARRAY_GUARD", 0);
  }
  if (r != null && typeof r === "object" && !Array.isArray(r) && "success" in r && "data" in r) {
    const inner = (r as { success: unknown; data: unknown }).data;
    (response as JsonRpcSuccess).result = inner != null && typeof inner === "object" && !Array.isArray(inner)
      ? inner
      : buildSoftFailureSupplyRisk("NO_DATA_RETURNED", 0);
  }
  return response;
}

const TOOL_TIMEOUT_MS = 35_000;

export interface UnlockResultShape {
  unlock_pressure_ratio: number;
  volume_impact_ratio: number;
  supply_inflation_percent: number;
  risk_score: number;
}

function isValidUnlockResult(value: unknown): value is UnlockResultShape {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  const a = o.unlock_pressure_ratio;
  const b = o.volume_impact_ratio;
  const c = o.supply_inflation_percent;
  const d = o.risk_score;
  return (
    typeof a === "number" &&
    typeof b === "number" &&
    typeof c === "number" &&
    typeof d === "number" &&
    Number.isFinite(a) &&
    Number.isFinite(b) &&
    Number.isFinite(c) &&
    Number.isFinite(d) &&
    a >= 0 &&
    b >= 0 &&
    c >= 0 &&
    d >= 0 &&
    d <= 100
  );
}

function isValidSupplyRiskResult(value: unknown): value is SupplyRiskOutputFlat {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  const meta = o.model_metadata;
  const validMeta =
    meta != null && typeof meta === "object" && !Array.isArray(meta) &&
    typeof (meta as Record<string, unknown>).model_version === "string" &&
    typeof (meta as Record<string, unknown>).analytics_layer === "string" &&
    typeof (meta as Record<string, unknown>).build_timestamp === "number" &&
    Number.isFinite((meta as Record<string, unknown>).build_timestamp as number);
  const fresh = o.data_freshness;
  const validFresh =
    fresh != null && typeof fresh === "object" && !Array.isArray(fresh) &&
    typeof (fresh as Record<string, unknown>).supply_snapshot_timestamp === "number" && Number.isFinite((fresh as Record<string, unknown>).supply_snapshot_timestamp as number) &&
    typeof (fresh as Record<string, unknown>).volume_snapshot_timestamp === "number" && Number.isFinite((fresh as Record<string, unknown>).volume_snapshot_timestamp as number) &&
    typeof (fresh as Record<string, unknown>).last_rpc_block_number === "number" && Number.isFinite((fresh as Record<string, unknown>).last_rpc_block_number as number) &&
    typeof (fresh as Record<string, unknown>).block_number_used === "number" && Number.isFinite((fresh as Record<string, unknown>).block_number_used as number) &&
    typeof (fresh as Record<string, unknown>).block_timestamp_used === "number" && Number.isFinite((fresh as Record<string, unknown>).block_timestamp_used as number);
  const curve = o.forward_risk_curve;
  if (curve == null || typeof curve !== "object" || Array.isArray(curve)) return false;
  const c = curve as Record<string, unknown>;
  const r30 = c.risk_30d;
  const r90 = c.risk_90d;
  const r180 = c.risk_180d;
  const ciLow = c.confidence_interval_low;
  const ciHigh = c.confidence_interval_high;
  const modelConf = c.model_confidence_score;
  const validCurve =
    typeof r30 === "number" && Number.isFinite(r30) && r30 >= 0 && r30 <= 100 &&
    typeof r90 === "number" && Number.isFinite(r90) && r90 >= 0 && r90 <= 100 &&
    typeof r180 === "number" && Number.isFinite(r180) && r180 >= 0 && r180 <= 100 &&
    typeof ciLow === "number" && Number.isFinite(ciLow) && ciLow >= 0 && ciLow <= 100 &&
    typeof ciHigh === "number" && Number.isFinite(ciHigh) && ciHigh >= 0 && ciHigh <= 100 &&
    typeof modelConf === "number" && Number.isFinite(modelConf) && modelConf >= 0 && modelConf <= 100;
  const nextTs = o.next_estimated_unlock_timestamp;
  const validNextTs = nextTs === null || (typeof nextTs === "number" && Number.isFinite(nextTs));
  const depth = o.liquidity_depth_profile;
  const validDepth =
    depth != null && typeof depth === "object" && !Array.isArray(depth) &&
    typeof (depth as Record<string, unknown>).impact_1pct === "number" && Number.isFinite((depth as Record<string, unknown>).impact_1pct as number) &&
    typeof (depth as Record<string, unknown>).impact_3pct === "number" && Number.isFinite((depth as Record<string, unknown>).impact_3pct as number) &&
    typeof (depth as Record<string, unknown>).impact_5pct === "number" && Number.isFinite((depth as Record<string, unknown>).impact_5pct as number);
  const sim = o.simulation_outcome;
  const validSim =
    sim === null ||
    (typeof sim === "object" && !Array.isArray(sim) &&
      typeof (sim as Record<string, unknown>).price_shock_impact_score === "number" && Number.isFinite((sim as Record<string, unknown>).price_shock_impact_score as number) &&
      typeof (sim as Record<string, unknown>).volume_shock_impact_score === "number" && Number.isFinite((sim as Record<string, unknown>).volume_shock_impact_score as number) &&
      typeof (sim as Record<string, unknown>).unlock_multiplier_impact_score === "number" && Number.isFinite((sim as Record<string, unknown>).unlock_multiplier_impact_score as number));
  const vCons = o.volume_source_consistency_score;
  const topHold = o.top_holder_concentration_score;
  const emitAcc = o.emission_acceleration_score;
  const riskFlags = o.risk_flags;
  const validRiskFlags = Array.isArray(riskFlags) && riskFlags.every((f) => typeof f === "string");
  const riskTier = o.risk_tier;
  const validRiskTier = typeof riskTier === "string";
  const hash = o.result_integrity_hash;
  const validHash = typeof hash === "string";
  const latency = o.engine_latency_ms;
  const validLatency = typeof latency === "number" && Number.isFinite(latency) && latency >= 0;
  const dq = o.data_quality_score;
  const validDataQuality = typeof dq === "number" && Number.isFinite(dq) && (dq as number) >= 0 && (dq as number) <= 100;
  const histLimited = o.historical_depth_limited;
  const validHistLimited = typeof histLimited === "boolean";
  const holderConf = o.holder_data_confidence_score;
  const validHolderConf = typeof holderConf === "number" && Number.isFinite(holderConf) && (holderConf as number) >= 0 && (holderConf as number) <= 100;
  const combinedVol = o.combined_volatility_index;
  const validCombinedVol = typeof combinedVol === "number" && Number.isFinite(combinedVol) && (combinedVol as number) >= 0 && (combinedVol as number) <= 100;
  const patternConf = o.pattern_confidence_score;
  const validPatternConf = typeof patternConf === "number" && Number.isFinite(patternConf) && (patternConf as number) >= 0 && (patternConf as number) <= 100;
  const scope = o.analysis_scope;
  const validScope = scope === "dynamic" || scope === "registry" || scope === "hybrid";
  const marketCapUsd = o.market_cap_usd;
  const validMarketCapUsd = marketCapUsd === undefined || (typeof marketCapUsd === "number" && Number.isFinite(marketCapUsd) && marketCapUsd >= 0);
  const volume24hUsd = o.volume_24h_usd;
  const validVolume24hUsd = volume24hUsd === undefined || (typeof volume24hUsd === "number" && Number.isFinite(volume24hUsd) && volume24hUsd >= 0);
  const liquidityUsd = o.liquidity_usd;
  const validLiquidityUsd = liquidityUsd === undefined || (typeof liquidityUsd === "number" && Number.isFinite(liquidityUsd) && liquidityUsd >= 0);
  const unlockMarketCapImpact = o.unlock_market_cap_impact;
  const validUnlockMarketCapImpact = unlockMarketCapImpact === undefined || (typeof unlockMarketCapImpact === "number" && Number.isFinite(unlockMarketCapImpact) && unlockMarketCapImpact >= 0);
  const unlockAmountUsd = o.unlock_amount_usd;
  const validUnlockAmountUsd = unlockAmountUsd === undefined || (typeof unlockAmountUsd === "number" && Number.isFinite(unlockAmountUsd) && unlockAmountUsd >= 0);
  const analysisTimestamp = o.analysis_timestamp;
  const validAnalysisTimestamp = typeof analysisTimestamp === "string" && analysisTimestamp.length > 0;
  const engineVersion = o.engine_version;
  const validEngineVersion = typeof engineVersion === "string" && engineVersion.length > 0;
  const dataFreshnessSeconds = o.data_freshness_seconds;
  const validDataFreshnessSeconds = typeof dataFreshnessSeconds === "number" && Number.isFinite(dataFreshnessSeconds) && dataFreshnessSeconds >= 0;
  const inf90 = o.inflation_rate_90d;
  const volIdx = o.supply_volatility_index;
  const pressureClass = o.unlock_pressure_classification;
  const fusedVol = o.fused_volume_30d_usd;
  const cliffPct = o.cliff_size_percent;
  const patternType = o.unlock_pattern_type;
  const treasuryExp = o.treasury_exposure_score;
  const maxUnlock = o.max_single_unlock_risk;
  return (
    validMeta &&
    validFresh &&
    typeof o.inflation_rate_30d === "number" && Number.isFinite(o.inflation_rate_30d as number) &&
    typeof inf90 === "number" && Number.isFinite(inf90 as number) &&
    typeof volIdx === "number" && Number.isFinite(volIdx as number) && (volIdx as number) >= 0 && (volIdx as number) <= 100 &&
    typeof o.emission_trend === "number" && Number.isFinite(o.emission_trend as number) &&
    typeof o.unlock_pressure_ratio === "number" && Number.isFinite(o.unlock_pressure_ratio as number) &&
    typeof pressureClass === "string" &&
    typeof fusedVol === "number" && Number.isFinite(fusedVol as number) && (fusedVol as number) >= 0 &&
    typeof o.liquidity_stress_score === "number" && Number.isFinite(o.liquidity_stress_score as number) &&
    (o.liquidity_stress_score as number) >= 0 && (o.liquidity_stress_score as number) <= 100 &&
    typeof o.cliff_detected === "boolean" &&
    typeof cliffPct === "number" && Number.isFinite(cliffPct as number) && (cliffPct as number) >= 0 && (cliffPct as number) <= 100 &&
    validNextTs &&
    typeof patternType === "string" &&
    validCurve &&
    typeof vCons === "number" && Number.isFinite(vCons as number) && (vCons as number) >= 0 && (vCons as number) <= 100 &&
    typeof topHold === "number" && Number.isFinite(topHold as number) && (topHold as number) >= 0 && (topHold as number) <= 100 &&
    typeof treasuryExp === "number" && Number.isFinite(treasuryExp as number) && (treasuryExp as number) >= 0 && (treasuryExp as number) <= 100 &&
    typeof maxUnlock === "number" && Number.isFinite(maxUnlock as number) && (maxUnlock as number) >= 0 && (maxUnlock as number) <= 100 &&
    validDepth &&
    typeof emitAcc === "number" && Number.isFinite(emitAcc as number) && (emitAcc as number) >= 0 && (emitAcc as number) <= 100 &&
    validSim &&
    validRiskFlags &&
    validRiskTier &&
    validHash &&
    validLatency &&
    validDataQuality &&
    validHistLimited &&
    validHolderConf &&
    validCombinedVol &&
    validPatternConf &&
    validScope &&
    validMarketCapUsd &&
    validVolume24hUsd &&
    validLiquidityUsd &&
    validUnlockMarketCapImpact &&
    validUnlockAmountUsd &&
    validAnalysisTimestamp &&
    validEngineVersion &&
    validDataFreshnessSeconds
  );
}

// ---------------------------------------------------------------------------
// Method handlers
// ---------------------------------------------------------------------------

function handleListTools(id: string | number | null): JsonRpcSuccess {
  return jsonRpcSuccess(id, { tools: MCP_TOOLS });
}

function toUnlockResult(report: {
  unlock_vs_volume_ratio: number;
  unlock_percent_supply: number;
  score_numeric: number;
}): UnlockResultShape {
  const ratio = Number(report.unlock_vs_volume_ratio) || 0;
  const pct = Number(report.unlock_percent_supply) || 0;
  const risk = Number(report.score_numeric) ?? 0;
  return {
    unlock_pressure_ratio: ratio,
    volume_impact_ratio: ratio,
    supply_inflation_percent: pct,
    risk_score: Math.round(Math.min(100, Math.max(0, risk))),
  };
}

/** Map supply risk flat to unlock report shape for dynamic-path fallback. */
function supplyRiskToUnlockReport(data: SupplyRiskOutputFlat): {
  unlock_vs_volume_ratio: number;
  unlock_percent_supply: number;
  score_numeric: number;
} {
  return {
    unlock_vs_volume_ratio: typeof data.unlock_pressure_ratio === "number" ? data.unlock_pressure_ratio : 0,
    unlock_percent_supply: typeof data.inflation_rate_30d === "number" ? data.inflation_rate_30d : 0,
    score_numeric: typeof data.liquidity_stress_score === "number" ? data.liquidity_stress_score : 0,
  };
}

async function handleAnalyzeTokenUnlock(
  id: string | number | null,
  symbol: string,
  deps: UnlockIntelligenceDeps
): Promise<JsonRpcSuccess | JsonRpcErrorBody> {
  const registry = createUnlockTokenRegistry();
  const resolved = await resolveTokenBySymbol(symbol, registry);
  const schedule = resolved
    ? await getScheduleByTokenCaseInsensitive(resolved.symbol, resolved.chain)
    : null;

  if (resolved && schedule) {
    try {
      const report = await Promise.race([
        getIntelligenceReport(resolved.symbol, deps),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Analysis timed out")), TOOL_TIMEOUT_MS)
        ),
      ]);
      const result = toUnlockResult(report);
      if (!isValidUnlockResult(result)) {
        return jsonRpcError(id, -32603, "Internal result validation failed.");
      }
      logger.info({ tool: UNLOCK_TOOL_NAME, token_symbol: symbol, risk_score: result.risk_score }, "MCP callTool success");
      return jsonRpcSuccess(id, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, message, token_symbol: symbol }, "MCP analyze_token_unlock error");
      return jsonRpcError(
        id,
        -32000,
        message.includes("timed out") ? "Analysis timed out. Try again or use a different token." : `Unlock analysis failed: ${message}.`
      );
    }
  }

  const symbolToResolve = resolved?.symbol ?? symbol;
  try {
    const cgData = await fetchCoinGeckoData(symbolToResolve);
    if (cgData?.address && cgData?.platform_chain) {
      const chain = cgData.platform_chain;
      if (chain === "ethereum" || chain === "arbitrum" || chain === "bsc") {
        const supplyResult = await Promise.race([
          runAnalyzeTokenSupplyRisk(
            { token_symbol: symbolToResolve, token_address: cgData.address, chain },
            deps
          ),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Analysis timed out")), TOOL_TIMEOUT_MS)
          ),
        ]);
        if (supplyResult.success && supplyResult.data) {
          const report = supplyRiskToUnlockReport(supplyResult.data);
          const result = toUnlockResult(report);
          if (!isValidUnlockResult(result)) {
            return jsonRpcError(id, -32603, "Internal result validation failed.");
          }
          logger.info(
            { tool: UNLOCK_TOOL_NAME, token_symbol: symbolToResolve, risk_score: result.risk_score, source: "dynamic" },
            "MCP callTool success (dynamic fallback)"
          );
          return jsonRpcSuccess(id, result);
        }
      }
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), token_symbol: symbolToResolve }, "Unlock: CoinGecko/dynamic fallback failed");
  }

  return jsonRpcError(id, -32000, "Token not supported on ethereum, bsc, or arbitrum");
}

async function handleAnalyzeTokenSupplyRisk(
  id: string | number | null,
  token: string,
  args: Record<string, unknown>,
  deps: UnlockIntelligenceDeps
): Promise<JsonRpcSuccess | JsonRpcErrorBody> {
  type ChainSlug = "ethereum" | "arbitrum" | "bsc";
  let chainSlug: ChainSlug | undefined =
    args.chain === "ethereum" || args.chain === "arbitrum" || args.chain === "bsc" ? (args.chain as ChainSlug) : undefined;
  const timeframeDays = typeof args.timeframe_days === "number" ? args.timeframe_days : undefined;
  let tokenAddress = typeof args.token_address === "string" ? args.token_address.trim() : undefined;
  const rawSim = args.simulation_params;
  let simulation_params: { price_shock_pct?: number; volume_shock_pct?: number; unlock_multiplier?: number } | undefined;
  if (rawSim != null && typeof rawSim === "object" && !Array.isArray(rawSim)) {
    const s = rawSim as Record<string, unknown>;
    simulation_params = {};
    if (typeof s.price_shock_pct === "number" && Number.isFinite(s.price_shock_pct)) simulation_params.price_shock_pct = s.price_shock_pct;
    if (typeof s.volume_shock_pct === "number" && Number.isFinite(s.volume_shock_pct)) simulation_params.volume_shock_pct = s.volume_shock_pct;
    if (typeof s.unlock_multiplier === "number" && Number.isFinite(s.unlock_multiplier)) simulation_params.unlock_multiplier = s.unlock_multiplier;
  }

  // Symbol-only upgrade: try CoinGecko resolution → dynamic engine; fallback to registry
  if (token && !tokenAddress) {
    try {
      const cgData = await fetchCoinGeckoData(token);
      if (cgData?.address && cgData?.platform_chain) {
        tokenAddress = cgData.address;
        chainSlug = cgData.platform_chain as ChainSlug;
      }
    } catch {
      // Silent fail — fallback to registry (tokenAddress and chainSlug remain undefined)
    }
  }

  try {
    const result = await Promise.race([
      runAnalyzeTokenSupplyRisk(
        {
          token_symbol: token,
          token_address: tokenAddress,
          chain: chainSlug,
          timeframe_days: timeframeDays,
          simulation_params,
        },
        deps
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Analysis timed out")), TOOL_TIMEOUT_MS)
      ),
    ]);
    if (!result.success) {
      const softFailure = buildSoftFailureSupplyRisk(
        result.error,
        result.engine_latency_ms ?? 0
      );
      if (!isValidSupplyRiskResult(softFailure)) {
        return jsonRpcError(id, -32603, "Internal result validation failed.");
      }
      return normalizeSupplyRiskResult(softFailure, id);
    }
    const data = result.data;
    if (!isValidSupplyRiskResult(data)) {
      return jsonRpcError(id, -32603, "Internal result validation failed.");
    }
    logger.info(
      { tool: SUPPLY_RISK_TOOL_NAME, token, liquidity_stress_score: data.liquidity_stress_score },
      "MCP callTool success"
    );
    return normalizeSupplyRiskResult(data, id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, message, token }, "MCP analyze_token_supply_risk error");
    const softFailure = buildSoftFailureSupplyRisk(message, 0);
    if (!isValidSupplyRiskResult(softFailure)) {
      return jsonRpcError(id, -32603, "Internal result validation failed.");
    }
    return normalizeSupplyRiskResult(softFailure, id);
  }
}

async function handleCallTool(
  id: string | number | null,
  params: unknown,
  deps: UnlockIntelligenceDeps | null | undefined
): Promise<JsonRpcSuccess | JsonRpcErrorBody> {
  if (!deps || typeof deps.chainProvider === "undefined" || typeof deps.marketProvider === "undefined") {
    logger.error("MCP handleCallTool: deps or required deps fields are undefined");
    return jsonRpcError(id, -32000, "Server configuration error. Please try again later.");
  }

  const p =
    params != null && typeof params === "object" && !Array.isArray(params)
      ? (params as { name?: unknown; arguments?: unknown })
      : {};
  const name = typeof p.name === "string" ? p.name : "";
  const rawArgs = p.arguments;
  const args = parseArguments(rawArgs);

  const tokenSymbol =
    (args as { token_symbol?: unknown }).token_symbol ??
    (args as { tokenSymbol?: unknown }).tokenSymbol ??
    (args as { token?: unknown }).token;
  const token = (typeof tokenSymbol === "string" ? tokenSymbol : tokenSymbol != null ? String(tokenSymbol) : "").trim();
  const tokenAddressArg = typeof (args as { token_address?: unknown }).token_address === "string"
    ? (args as { token_address: string }).token_address.trim()
    : "";

  if (name === UNLOCK_TOOL_NAME) {
    if (typeof tokenSymbol !== "string" && tokenSymbol != null) {
      return jsonRpcError(id, -32602, "Invalid params: token_symbol must be a string.");
    }
    if (!token) {
      logger.warn({ tool: name }, "MCP missing required argument: token_symbol");
      return jsonRpcError(id, -32602, "Missing required argument: token_symbol. Provide a token ticker (e.g. ARB, ETH).");
    }
    return handleAnalyzeTokenUnlock(id, token, deps);
  }
  if (name === SUPPLY_RISK_TOOL_NAME) {
    if (tokenSymbol != null && typeof tokenSymbol !== "string") {
      return jsonRpcError(id, -32602, "Invalid params: token_symbol must be a string.");
    }
    if (!token && !tokenAddressArg) {
      logger.warn({ tool: name }, "MCP missing token_symbol or token_address");
      return jsonRpcError(id, -32602, "Missing required argument: token_symbol or token_address. For dynamic analysis provide token_address and chain.");
    }
    return handleAnalyzeTokenSupplyRisk(id, token, args, deps);
  }

  logger.warn({ name }, "MCP unknown tool");
  return jsonRpcError(id, -32602, `Unknown tool: ${name || "(missing)"}. Supported: ${UNLOCK_TOOL_NAME}, ${SUPPLY_RISK_TOOL_NAME}.`);
}

function handleInitialize(id: string | number | null): JsonRpcSuccess {
  return jsonRpcSuccess(id, {
    protocolVersion: "2024-11-05",
    serverInfo: { name: "token-unlock-intelligence-mcp", version: "1.0.0" },
    capabilities: { tools: {} },
  });
}

// ---------------------------------------------------------------------------
// POST /mcp handler
// ---------------------------------------------------------------------------

export function registerMcpRoute(
  app: { post: (path: string, ...handlers: RequestHandler[]) => void },
  deps: UnlockIntelligenceDeps,
  middleware: RequestHandler[] = []
): void {
  const handler: RequestHandler = async (req: Request, res: Response): Promise<void> => {
    try {
      const body = parseBody(req.body);

      if (process.env.NODE_ENV !== "production" && body != null) {
        logger.debug({ method: body.method }, "MCP call received");
      }

      if (!body) {
        safeSend(res, jsonRpcError(null, -32600, "Invalid Request: body must be a JSON object."));
        return;
      }

      const { jsonrpc, id, method, params } = body;
      const requestId = id ?? null;

      if (jsonrpc !== "2.0") {
        safeSend(res, jsonRpcError(requestId, -32600, "Invalid Request: jsonrpc must be '2.0'."));
        return;
      }

      const methodName = typeof method === "string" ? method : "";

      let response: JsonRpcSuccess | JsonRpcErrorBody;

      if (methodName === "listTools" || methodName === "tools/list") {
        response = handleListTools(requestId);
      } else if (methodName === "callTool" || methodName === "tools/call") {
        response = await handleCallTool(requestId, params, deps);
      } else if (methodName === "analyze_token_supply_risk") {
        const args = parseArguments(params);
        const tokenSymbol = args.token_symbol ?? args.tokenSymbol ?? args.token;
        const token = (typeof tokenSymbol === "string" ? tokenSymbol : tokenSymbol != null ? String(tokenSymbol) : "").trim();
        response = await handleAnalyzeTokenSupplyRisk(requestId, token, args, deps);
      } else if (methodName === "initialize") {
        response = handleInitialize(requestId);
      } else if (methodName === "") {
        response = jsonRpcError(requestId, -32600, "Invalid Request: method is required.");
      } else {
        // Context lifecycle notifications (safe to ignore)
        if (typeof method === "string" && method.startsWith("notifications/")) {
          safeSend(res, { jsonrpc: "2.0", id: null, result: null });
          return;
        }
        logger.warn({ method: methodName }, "MCP method not found");
        response = jsonRpcError(requestId, -32601, `Method not found: ${methodName}.`);
      }

      if (!response || typeof response !== "object" || !("jsonrpc" in response)) {
        response = jsonRpcSuccess(requestId, buildSoftFailureSupplyRisk("INVALID_ROUTER_RESPONSE", 0));
      }
      if ("result" in response && Array.isArray((response as JsonRpcSuccess).result)) {
        response = jsonRpcSuccess(requestId, buildSoftFailureSupplyRisk("EMPTY_RESULT", 0));
      }
      response = ensureFlatResultPayload(response, requestId);
      if ("result" in response) {
        const result = (response as JsonRpcSuccess).result;
        logger.info(
          {
            finalPayloadType: typeof result,
            isArray: Array.isArray(result),
            keys: result != null && typeof result === "object" && !Array.isArray(result) ? Object.keys(result).slice(0, 20) : null,
          },
          "MCP final payload shape"
        );
      }
      safeSend(res, response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, message }, "MCP POST unhandled error");
      const errorMessage =
        process.env.NODE_ENV === "production"
          ? "Unexpected server error. Please try again."
          : `Unexpected server error: ${message}.`;
      safeSend(res, jsonRpcError(null, -32603, errorMessage));
    }
  };
  app.post("/mcp", ...middleware, handler);
}
