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
  buildCompletedNoDataSupplyRisk,
  type SupplyRiskOutputFlat,
} from "../tools/analyze_token_supply_risk.js";
import { fetchCoinGeckoData, normalizeCoinGeckoChainToSlug } from "../services/marketData/coingeckoClient.js";
import { resolveAsset } from "../core/assetResolver.js";
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
      "Multi-chain token supply risk engine: historical unlocks, vesting cliffs, emission patterns, liquidity stress for Ethereum, Arbitrum, BSC. For any token on Ethereum, BSC, or Arbitrum, providing token_address (contract address) and chain ensures correct EVM classification and full analysis (onchain, unlock, risk, SSI).",
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
      description: "Provide token_address + chain for any EVM token (recommended: ensures correct classification). Symbol-only resolution uses CoinGecko and internal registry; for tokens not listed there, provide token_address and chain when available. At least one of (token_symbol) or (token_address and chain) is required.",
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
        unlock_pressure_ratio: { type: "number" as const, description: "Scheduled unlock pressure from calendar/scanner; 0 when no unlock data." },
        unlock_pressure_classification: {
          type: "string" as const,
          description: "LOW | MODERATE | HIGH | EXTREME from scheduled unlocks; NO_SCHEDULED_DATA when no calendar/scanner data.",
        },
        fused_volume_30d_usd: { type: "number" as const },
        liquidity_stress_score: { type: "number" as const },
        cliff_detected: { type: "boolean" as const },
        cliff_size_percent: { type: "number" as const },
        next_estimated_unlock_timestamp: { type: ["number", "null"] as const },
        unlock_schedule_status: {
          type: "string" as const,
          enum: ["active", "completed"] as const,
          description: "active = future unlock scheduled; completed = no future unlock (schedule ended or all past).",
        },
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
        analysis_scope: {
          type: "string" as const,
          enum: ["dynamic", "registry", "hybrid", "dynamic_fallback", "unlock_only", "combined", "supply_only", "insufficient"] as const,
          description: "Scope of analysis: combined (unlock + supply), unlock_only, supply_only, insufficient, or legacy dynamic/registry/hybrid.",
        },
        analysis_provenance: {
          type: "object" as const,
          description: "Intelligence provenance: which model produced the result and why.",
          properties: {
            primary_model: { type: "string" as const, enum: ["registry", "dynamic_unlock", "holder_distribution"] as const },
            fallback_used: { type: "boolean" as const },
            unlock_data_available: { type: "boolean" as const },
            confidence_basis: { type: "string" as const, enum: ["unlock_events", "holder_distribution", "mixed"] as const },
          },
          required: ["primary_model", "fallback_used", "unlock_data_available", "confidence_basis"] as const,
        },
        search_exhausted: {
          type: "boolean" as const,
          description: "True when analysis completed and no records were found. Absence of data is a valid analytical outcome, not a failure.",
        },
        records_found: {
          type: "number" as const,
          description: "Number of unlock or risk records discovered.",
        },
        no_results_reason: {
          type: "string" as const,
          description: "Machine-readable reason when no data was found (e.g. no_matching_data). Indicates completed analysis, not infrastructure failure.",
        },
        analysis_completion_status: {
          type: "string" as const,
          enum: ["success", "completed_no_data", "failed"] as const,
          description: "success = data returned; completed_no_data = analysis completed with no matching data (valid outcome); failed = analysis could not complete.",
        },
        data_availability_status: {
          type: "string" as const,
          description: "data_available when result has data; completed_no_data when analysis completed but no data found. Enables validators to treat response as COMPLETE.",
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
        unlock_model: {
          type: "string" as const,
          description: "Set when unlock intelligence is inferred (e.g. INFERRED_SUPPLY_SHOCK) when no scanner/registry data.",
        },
        inference_source: {
          type: "string" as const,
          description: "Source of inferred unlock metrics (e.g. dynamic_supply_model).",
        },
        confidence_score: {
          type: "number" as const,
          description: "Confidence in inferred unlock metrics (0–100).",
        },
        unlock_data_source: {
          type: "string" as const,
          enum: ["registry", "external_calendar", "scanner", "inferred"] as const,
          description: "Unlock intelligence source: registry > external_calendar > scanner > inferred.",
        },
        unlock_provider: {
          type: "string" as const,
          description: "Unlock provider name (e.g. CryptoRank, ManualRegistry) when unlock data was used.",
        },
        unlock_provider_confidence: {
          type: "number" as const,
          description: "Unlock provider confidence 0–1; used to weight unlock in SSI.",
        },
        supply_shock_index: {
          type: "number" as const,
          description: "Supply Shock Fusion Index (SSI) 0–100.",
        },
        supply_shock_risk_tier: {
          type: "string" as const,
          enum: ["LOW", "MODERATE", "HIGH", "EXTREME"] as const,
          description: "SSI risk tier: 0–25 LOW, 26–50 MODERATE, 51–75 HIGH, 76–100 EXTREME.",
        },
        inferred_distribution_pressure: {
          type: "number" as const,
          description: "Inferred supply/distribution pressure when no scheduled unlock data; 0 or omitted when unlock data available.",
        },
        inferred_distribution_classification: {
          type: "string" as const,
          description: "Risk classification of inferred distribution pressure (e.g. MODERATE); only set when unlock_data_available is false.",
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
        "analysis_provenance",
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

/** Defensive normalizer: never return [] to Context; empty/null → soft failure, array → unwrap to flat object only. */
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
    let flat: unknown =
      first != null && typeof first === "object" && !Array.isArray(first) && "data" in first
        ? (first as { data: unknown }).data
        : first;
    if (flat == null || Array.isArray(flat) || typeof flat !== "object") {
      flat = buildSoftFailureSupplyRisk("EMPTY_ARRAY_GUARD", 0);
    }
    return jsonRpcSuccess(id, flat);
  }
  if (typeof maybeResult === "object" && !Array.isArray(maybeResult)) {
    return jsonRpcSuccess(id, maybeResult);
  }
  const softFailure = buildSoftFailureSupplyRisk("UNEXPECTED_RESULT_SHAPE", 0);
  return jsonRpcSuccess(id, softFailure);
}

/**
 * Ensure JSON-RPC result is always a flat object for Context (never [], null, or { success, data }).
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
  }
  if (r == null || Array.isArray(r) || typeof r !== "object") {
    (response as JsonRpcSuccess).result = buildSoftFailureSupplyRisk("EMPTY_ARRAY_GUARD", 0);
    return response;
  }
  if (typeof r === "object" && !Array.isArray(r) && "success" in r && "data" in r) {
    const inner = (r as { success: unknown; data: unknown }).data;
    (response as JsonRpcSuccess).result =
      inner != null && typeof inner === "object" && !Array.isArray(inner)
        ? inner
        : buildSoftFailureSupplyRisk("NO_DATA_RETURNED", 0);
  }
  return response;
}

/**
 * MCP tools/call result shape: content[] with type "text" and string "text" (Context/Zod expect this, not type "json").
 * See https://modelcontextprotocol.io/specification/2025-11-25/server/tools — Tool Result content is TextContent.
 */
function addToolsCallContentCompat(response: JsonRpcSuccess | JsonRpcErrorBody): JsonRpcSuccess | JsonRpcErrorBody {
  if (!("result" in response)) return response;
  const r = (response as JsonRpcSuccess).result;
  if (r == null || typeof r !== "object" || Array.isArray(r)) return response;
  const obj = r as Record<string, unknown>;
  if (Array.isArray(obj.content) && obj.content.length > 0) {
    const first = obj.content[0] as Record<string, unknown> | undefined;
    if (first?.type === "text" && typeof first.text === "string") return response;
  }
  (response as JsonRpcSuccess).result = {
    ...obj,
    content: [{ type: "text" as const, text: JSON.stringify(obj) }],
    isError: false,
  };
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
  const validScope = scope === "dynamic" || scope === "registry" || scope === "hybrid" || scope === "dynamic_fallback";
  const provenance = o.analysis_provenance;
  const validProvenance =
    provenance == null ||
    (typeof provenance === "object" &&
      !Array.isArray(provenance) &&
      (provenance as Record<string, unknown>).primary_model !== undefined &&
      (provenance as Record<string, unknown>).fallback_used === !!((provenance as Record<string, unknown>).fallback_used) &&
      (provenance as Record<string, unknown>).unlock_data_available === !!((provenance as Record<string, unknown>).unlock_data_available) &&
      ["registry", "dynamic_unlock", "holder_distribution"].includes((provenance as Record<string, unknown>).primary_model as string) &&
      ["unlock_events", "holder_distribution", "mixed"].includes((provenance as Record<string, unknown>).confidence_basis as string));
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
    validProvenance &&
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
  let cgData: Awaited<ReturnType<typeof fetchCoinGeckoData>> = null;
  try {
    cgData = await fetchCoinGeckoData(symbolToResolve);
    if (cgData?.address && cgData?.platform_chain) {
      const chainSlug = normalizeCoinGeckoChainToSlug(cgData.platform_chain);
      if (chainSlug) {
        const supplyResult = await Promise.race([
          runAnalyzeTokenSupplyRisk(
            { token_symbol: symbolToResolve, token_address: cgData.address, chain: chainSlug },
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

  const hasCgData = !!cgData;
  const hasAddress = !!(cgData?.address);
  const platformChain = cgData?.platform_chain ?? null;
  if (!hasCgData && !hasAddress && platformChain === null) {
    const asset = await resolveAsset({ symbol: symbolToResolve });
    if (asset.supported && asset.contract_address && (asset.chain === "ethereum" || asset.chain === "bsc" || asset.chain === "arbitrum")) {
      try {
        const supplyResult = await Promise.race([
          runAnalyzeTokenSupplyRisk(
            { token_symbol: symbolToResolve, token_address: asset.contract_address, chain: asset.chain },
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
            { tool: UNLOCK_TOOL_NAME, token_symbol: symbolToResolve, risk_score: result.risk_score, source: "resolveAsset" },
            "MCP callTool success (resolveAsset fallback)"
          );
          return jsonRpcSuccess(id, result);
        }
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err), token_symbol: symbolToResolve }, "Unlock: resolveAsset supply risk fallback failed");
      }
    }
    if (asset.unresolved) {
      logger.info({ symbol: symbolToResolve, classification: "NO_SCHEDULED_DATA" }, "Unlock: unresolved asset, no scheduled data");
      return jsonRpcSuccess(id, {
        supported: false,
        classification: "NO_SCHEDULED_DATA",
        chain_type: "non_evm",
        message: "No unlock data found for this token. It was not found in CoinGecko, the unlock registry, or known EVM symbols. Provide token_address and chain for EVM tokens when available.",
        unlock_pressure_ratio: 0,
        volume_impact_ratio: 0,
        supply_inflation_percent: 0,
        risk_score: 0,
      });
    }
    logger.warn(
      { symbol: symbolToResolve },
      "UNLOCK_TOKEN_NATIVE_CHAIN_UNSUPPORTED"
    );
    logger.info(
      {
        symbol: symbolToResolve,
        supported: false,
        classification: "NATIVE_CHAIN_ASSET",
      },
      "Unlock: native chain asset (non-EVM)"
    );
    return jsonRpcSuccess(id, {
      supported: false,
      classification: "NATIVE_CHAIN_ASSET",
      chain_type: "non_evm",
      message: "Token is native to a non-EVM chain. Unlock schedules must be sourced from protocol documentation.",
      unlock_pressure_ratio: 0,
      volume_impact_ratio: 0,
      supply_inflation_percent: 0,
      risk_score: 0,
    });
  }
  logger.warn(
    { symbol: symbolToResolve, hasCgData, hasAddress, platform_chain: platformChain },
    "UNLOCK_TOKEN_NATIVE_CHAIN_UNSUPPORTED"
  );
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
  logger.info({ token: token || undefined, token_address: tokenAddress, chain: chainSlug }, "SUPPLY_HANDLER_ENTERED");
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
        const slug = normalizeCoinGeckoChainToSlug(cgData.platform_chain);
        if (slug) chainSlug = slug;
      }
    } catch {
      // Silent fail — fallback to registry (tokenAddress and chainSlug remain undefined)
    }
  }

  try {
    let result = await Promise.race([
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
    if (result == null || typeof result !== "object" || Array.isArray(result) || !("success" in result)) {
      const softFailure = buildSoftFailureSupplyRisk("INVALID_INTERNAL_RETURN", 0);
      return normalizeSupplyRiskResult(softFailure, id);
    }
    if (result.success && (result.data == null || Array.isArray(result.data))) {
      const softFailure = buildSoftFailureSupplyRisk(
        Array.isArray(result.data) && result.data.length === 0 ? "EMPTY_ARRAY_GUARD" : "NO_DATA_RETURNED",
        0
      );
      return normalizeSupplyRiskResult(softFailure, id);
    }
    if (!result.success) {
      const elapsedMs = result.engine_latency_ms ?? 0;
      const completedNoData = buildCompletedNoDataSupplyRisk(elapsedMs);
      if (!isValidSupplyRiskResult(completedNoData)) {
        logger.warn("SUPPLY_VALIDATION_FAILED");
        const fallback = buildCompletedNoDataSupplyRisk(result.engine_latency_ms ?? 0);
        return normalizeSupplyRiskResult(fallback, id);
      }
      return normalizeSupplyRiskResult(completedNoData, id);
    }
    const data = result.data;
    if (!isValidSupplyRiskResult(data)) {
      logger.warn("SUPPLY_VALIDATION_FAILED");
      const softFailure = buildSoftFailureSupplyRisk(
        "VALIDATION_FAILED",
        (data as { engine_latency_ms?: number } | undefined)?.engine_latency_ms ?? 0
      );
      return normalizeSupplyRiskResult(softFailure, id);
    }
    logger.info("SUPPLY_HANDLER_RETURNING_SUCCESS");
    logger.info(
      { tool: SUPPLY_RISK_TOOL_NAME, token, liquidity_stress_score: data.liquidity_stress_score },
      "MCP callTool success"
    );
    return normalizeSupplyRiskResult(data, id);
  } catch (err) {
    logger.error({ err, token }, "MCP analyze_token_supply_risk error");
    const completedNoData = buildCompletedNoDataSupplyRisk(0);
    if (!isValidSupplyRiskResult(completedNoData)) {
      logger.warn("SUPPLY_VALIDATION_FAILED");
      const fallback = buildCompletedNoDataSupplyRisk(0);
      return normalizeSupplyRiskResult(fallback, id);
    }
    return normalizeSupplyRiskResult(completedNoData, id);
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
  logger.info({ name }, "CALL_TOOL_ENTERED");
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
      if ("result" in response) {
        const r = (response as JsonRpcSuccess).result;
        if (r == null || Array.isArray(r) || typeof r !== "object") {
          response = jsonRpcSuccess(requestId, buildSoftFailureSupplyRisk("INVALID_RESULT_SHAPE", 0));
        } else if ("success" in r && "data" in r) {
          const inner = (r as { success: unknown; data: unknown }).data;
          response = jsonRpcSuccess(
            requestId,
            inner != null && typeof inner === "object" && !Array.isArray(inner)
              ? inner
              : buildSoftFailureSupplyRisk("EMPTY_DATA_GUARD", 0)
          );
        }
      }
      response = ensureFlatResultPayload(response, requestId);
      if (
        (methodName === "callTool" || methodName === "tools/call") &&
        "result" in response &&
        (response as JsonRpcSuccess).result &&
        typeof (response as JsonRpcSuccess).result === "object" &&
        !Array.isArray((response as JsonRpcSuccess).result)
      ) {
        response = addToolsCallContentCompat(response);
      }
      if ("result" in response) {
        if (Array.isArray((response as JsonRpcSuccess).result) || (response as JsonRpcSuccess).result == null) {
          response = jsonRpcSuccess(requestId, buildSoftFailureSupplyRisk("FINAL_GUARD_ARRAY_BLOCKED", 0));
        }
      }
      logger.info(
        {
          id: requestId,
          method: methodName,
          hasResult: "result" in response,
          resultKeys:
            "result" in response && (response as JsonRpcSuccess).result != null && typeof (response as JsonRpcSuccess).result === "object" && !Array.isArray((response as JsonRpcSuccess).result)
              ? Object.keys((response as JsonRpcSuccess).result as object).slice(0, 15)
              : null,
        },
        "FINAL_JSON_RPC_RESPONSE_SENT"
      );
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