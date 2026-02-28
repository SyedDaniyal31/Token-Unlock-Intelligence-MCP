/**
 * Production MCP JSON-RPC handler for POST /mcp.
 * Context Protocol compliant: listTools, callTool (tools/list, tools/call).
 * Returns -32603 when result validation fails (internal error); uses -32000 for
 * unresolvable/operational failures (e.g. timeout, token not supported).
 */ 

import type { Request, Response } from "express";
import type { RequestHandler } from "express";
import type { UnlockIntelligenceDeps } from "../intelligence/unlockIntelligence.js";
import {
  runAnalyzeTokenSupplyRisk,
  buildSoftFailureSupplyRisk,
  buildCompletedNoDataSupplyRisk,
  type SupplyRiskOutputFlat,
} from "../tools/analyze_token_supply_risk.js";
import { computeUnlockRisk } from "../core/unlockRiskModel.js";
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
      "Token unlock risk analysis for ETH, BSC, Arbitrum, Base. Uses scheduled token release events and market data. Returns supply inflation %, unlock pressure, risk score.",
    inputSchema: {
      type: "object" as const,
      properties: {
        token_symbol: { type: "string" as const, description: "Token ticker (e.g. MITO, ARB, ETH)" },
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
          enum: ["ethereum", "arbitrum", "bsc", "base"] as const,
          description: "Chain to analyze; required when using token_address. Supported: ethereum, bsc, arbitrum, base.",
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
        final_risk_tier: { type: "string" as const, description: "MINOR | ELEVATED | HIGH | CRITICAL from composite score." },
        event_severity_label: { type: "string" as const },
        absorption_risk_label: { type: "string" as const },
        timing_urgency_label: { type: "string" as const },
        composite_score: { type: "number" as const },
        result_integrity_hash: { type: "string" as const },
        engine_latency_ms: { type: "number" as const },
        data_quality_score: { type: "number" as const },
        historical_depth_limited: { type: "boolean" as const },
        holder_data_confidence_score: { type: "number" as const },
        combined_volatility_index: { type: "number" as const },
        pattern_confidence_score: { type: "number" as const },
        analysis_scope: {
          type: "string" as const,
          enum: ["dynamic", "registry", "hybrid", "dynamic_fallback", "technical_onchain", "unlock_only", "combined", "supply_only", "insufficient", "unsupported", "scheduled_unlock"] as const,
          description: "Scope of analysis: combined, unlock_only, supply_only, insufficient, unsupported, or scheduled_unlock.",
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
        supply_unlock_percent: {
          type: "number" as const,
          description: "Unlock amount / circulating supply (0–1). Supply shock severity layer.",
        },
        supply_unlock_classification: {
          type: "string" as const,
          enum: ["LOW", "MODERATE", "HIGH", "EXTREME"] as const,
          description: "Supply shock classification from unlock % of supply: >=15% EXTREME, >=5% HIGH, >=2% MODERATE.",
        },
        inferred_distribution_pressure: {
          type: "number" as const,
          description: "Inferred supply/distribution pressure when no scheduled unlock data; 0 or omitted when unlock data available.",
        },
        unlock_event_assessment: {
          type: "object" as const,
          description: "Institutional-grade event severity block (primary output).",
          properties: {
            severity: { type: "string" as const, enum: ["EXTREME", "HIGH", "ELEVATED", "MODERATE"] as const },
            unlock_percent_of_total_supply: { type: "number" as const },
            unlock_amount: { type: ["number", "null"] as const },
            unlock_date: { type: ["string", "null"] as const },
            days_until_unlock: { type: ["number", "null"] as const },
          },
        },
        market_impact_analysis: {
          type: "object" as const,
          description: "Market impact block: volume ratio, liquidity absorption, and market interpretation.",
          properties: {
            volume_ratio_days: { type: "number" as const },
            liquidity_absorption_classification: { type: "string" as const, enum: ["LOW", "MODERATE", "HIGH"] as const },
            market_interpretation: { type: "string" as const, description: "Professional interpretive statement on absorption, volatility, repricing." },
          },
        },
        assessment_report: {
          type: "string" as const,
          description: "Formatted institutional report: Unlock Event Assessment + Market Impact Analysis.",
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
        "final_risk_tier",
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

/** Use new risk model for severity/absorption/timing labels. */
function getRiskLabels(obj: Record<string, unknown>): {
  event_severity_label: string;
  absorption_risk_label: string;
  timing_urgency_label: string;
  composite_score: number;
  final_risk_tier: string;
} {
  const pct = typeof obj.supply_unlock_percent === "number" && Number.isFinite(obj.supply_unlock_percent as number)
    ? (obj.supply_unlock_percent as number)
    : 0;
  const unlockAmount = typeof obj.unlock_amount_usd === "number" && Number.isFinite(obj.unlock_amount_usd as number)
    ? (obj.unlock_amount_usd as number)
    : 0;
  const fusedVol = typeof obj.fused_volume_30d_usd === "number" && Number.isFinite(obj.fused_volume_30d_usd as number)
    ? (obj.fused_volume_30d_usd as number)
    : 0;
  const avgDaily = fusedVol > 0 ? fusedVol / 30 : 1;
  const nextTs = typeof obj.next_estimated_unlock_timestamp === "number" && Number.isFinite(obj.next_estimated_unlock_timestamp as number)
    ? (obj.next_estimated_unlock_timestamp as number)
    : null;
  const r = computeUnlockRisk({
    unlock_percent_of_circulating: pct,
    unlock_amount: unlockAmount,
    avg_daily_volume: avgDaily,
    next_unlock_timestamp: nextTs,
  });
  return {
    event_severity_label: r.event_severity_label,
    absorption_risk_label: r.absorption_risk_label,
    timing_urgency_label: r.timing_urgency_label,
    composite_score: r.composite_score,
    final_risk_tier: r.final_risk_tier,
  };
}

/** Human-readable date from Unix timestamp. */
function formatEventDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Market interpretation from unlock percent (0–1). Professional language; absorption, volatility, repricing.
 */
function getMarketInterpretation(unlockPercent: number): string {
  if (unlockPercent >= 0.2) {
    return "Events of this magnitude often trigger short-term volatility spikes and directional repricing as new supply enters circulation.";
  }
  if (unlockPercent >= 0.1) {
    return "Such events typically increase short-term liquidity demand and may pressure price if absorption capacity is limited.";
  }
  if (unlockPercent >= 0.05) {
    return "Scheduled releases in this range may increase near-term liquidity demand; absorption capacity is the primary constraint on price impact.";
  }
  return "The scheduled release is unlikely to materially alter supply dynamics.";
}

/**
 * Build institutional-grade unlock assessment output.
 * Primary: Event Severity Block, Market Impact Analysis. Decisive tone. No confidence scores or internal flags.
 */
function buildInstitutionalOutput(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const now = Math.floor(Date.now() / 1000);
  const supplyUnlockPct = typeof obj.supply_unlock_percent === "number" && Number.isFinite(obj.supply_unlock_percent as number)
    ? (obj.supply_unlock_percent as number)
    : 0;
  const nextTs = typeof obj.next_estimated_unlock_timestamp === "number" && Number.isFinite(obj.next_estimated_unlock_timestamp as number)
    ? (obj.next_estimated_unlock_timestamp as number)
    : null;
  const unlockPressureRatio = typeof obj.unlock_pressure_ratio === "number" && Number.isFinite(obj.unlock_pressure_ratio as number)
    ? (obj.unlock_pressure_ratio as number)
    : 0;
  const liquidityStress = typeof obj.liquidity_stress_score === "number" && Number.isFinite(obj.liquidity_stress_score as number)
    ? Math.max(0, Math.min(100, obj.liquidity_stress_score as number))
    : 0;
  const unlockAmountUsd = typeof obj.unlock_amount_usd === "number" && Number.isFinite(obj.unlock_amount_usd as number)
    ? (obj.unlock_amount_usd as number)
    : undefined;

  const riskLabels = getRiskLabels(obj);
  const magnitudePct = Number((supplyUnlockPct * 100).toFixed(1));
  const eventDate = nextTs != null ? formatEventDate(nextTs) : null;
  const daysUntilUnlock = nextTs != null ? Math.max(0, Math.ceil((nextTs - now) / 86400)) : null;
  const volumeRatioDays = Number((unlockPressureRatio * 30).toFixed(1));

  out.unlock_event_assessment = {
    severity: riskLabels.event_severity_label,
    unlock_percent_of_total_supply: magnitudePct,
    unlock_amount: unlockAmountUsd ?? null,
    unlock_date: eventDate,
    days_until_unlock: daysUntilUnlock,
    event_severity_label: riskLabels.event_severity_label,
    absorption_risk_label: riskLabels.absorption_risk_label,
    timing_urgency_label: riskLabels.timing_urgency_label,
    composite_score: riskLabels.composite_score,
    final_risk_tier: riskLabels.final_risk_tier,
  };

  const marketInterpretation = getMarketInterpretation(supplyUnlockPct);

  out.market_impact_analysis = {
    volume_ratio_days: volumeRatioDays,
    liquidity_absorption_classification: riskLabels.absorption_risk_label,
    market_interpretation: marketInterpretation,
  };

  const lines: string[] = [];
  lines.push("=== Unlock Event Assessment ===");
  lines.push(`Severity: ${riskLabels.event_severity_label}`);
  lines.push(`Magnitude: ${magnitudePct}% of total supply`);
  lines.push(`Event Date: ${eventDate ?? "—"}`);
  lines.push(`Days Until Event: ${daysUntilUnlock != null ? `${daysUntilUnlock} days` : "—"}`);
  lines.push("");
  lines.push("=== Market Impact Analysis ===");
  lines.push(`Unlock equals ${volumeRatioDays} days of average trading volume.`);
  lines.push(`Liquidity absorption classified as ${riskLabels.absorption_risk_label}.`);
  lines.push("");
  lines.push("=== Market Interpretation ===");
  lines.push(marketInterpretation);

  out.assessment_report = lines.join("\n");

  if (supplyUnlockPct >= 0.2 && nextTs != null) {
    out.analysis_summary = `A large supply expansion event of ${magnitudePct}% of total supply is scheduled for ${eventDate}. ${marketInterpretation}`;
  } else if (supplyUnlockPct >= 0.1 && nextTs != null) {
    out.analysis_summary = `A significant supply expansion event of ${magnitudePct}% of total supply is scheduled for ${eventDate}. ${marketInterpretation}`;
  } else if (supplyUnlockPct >= 0.05) {
    out.analysis_summary = `An elevated supply expansion event of ${magnitudePct}% of total supply is scheduled. ${marketInterpretation}`;
  } else {
    out.analysis_summary = `This analysis reflects scheduled token release events. ${marketInterpretation}`;
  }

  out.token_symbol = obj.token_symbol;
  out.analysis_scope = obj.analysis_scope === "calendar_only" ? "scheduled_unlock" : obj.analysis_scope;
  out.unlock_pressure_ratio = obj.unlock_pressure_ratio;
  out.event_severity_label = riskLabels.event_severity_label;
  out.absorption_risk_label = riskLabels.absorption_risk_label;
  out.timing_urgency_label = riskLabels.timing_urgency_label;
  out.composite_score = riskLabels.composite_score;
  out.final_risk_tier = riskLabels.final_risk_tier;
  out.analysis_timestamp = obj.analysis_timestamp;
  out.engine_version = obj.engine_version;

  return out;
}

/**
 * Sanitize user-facing output: institutional-grade format, remove internal references.
 */
function sanitizeUserFacingOutput(obj: Record<string, unknown>): Record<string, unknown> {
  return buildInstitutionalOutput(obj);
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
  if (typeof (response as JsonRpcSuccess).result === "object" && (response as JsonRpcSuccess).result != null && !Array.isArray((response as JsonRpcSuccess).result)) {
    (response as JsonRpcSuccess).result = sanitizeUserFacingOutput((response as JsonRpcSuccess).result as Record<string, unknown>);
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
  const finalRiskTier = o.final_risk_tier;
  const validFinalRiskTier = typeof finalRiskTier === "string";
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
  const validScope = scope === "dynamic" || scope === "registry" || scope === "hybrid" || scope === "dynamic_fallback" || scope === "technical_onchain" || scope === "unlock_only" || scope === "combined" || scope === "supply_only" || scope === "insufficient" || scope === "unsupported" || scope === "scheduled_unlock";
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
    validFinalRiskTier &&
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

/**
 * Unified flow: 1) Scheduled unlock data 2) CoinGecko for price/chain 3) Risk analysis.
 * Supports ETH, BSC, ARB, Base. Uses scheduled release events; supports non-EVM when unlock data is available.
 */
async function handleAnalyzeTokenUnlock(
  id: string | number | null,
  symbol: string,
  deps: UnlockIntelligenceDeps
): Promise<JsonRpcSuccess | JsonRpcErrorBody> {
  const symbolNorm = (symbol ?? "").trim().toUpperCase().replace(/^\$/, "");
  if (!symbolNorm) {
    return jsonRpcError(id, -32602, "token_symbol is required.");
  }

  try {
    // Single path: runAnalyzeTokenSupplyRisk uses scheduled unlock data, CoinGecko, then full analysis
    const supplyResult = await Promise.race([
      runAnalyzeTokenSupplyRisk({ token_symbol: symbolNorm }, deps),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Analysis timed out")), TOOL_TIMEOUT_MS)
      ),
    ]);

    if (!supplyResult?.success || !supplyResult.data) {
      return jsonRpcSuccess(id, {
        supported: false,
        classification: "NO_SCHEDULED_DATA",
        message: "No unlock data found for this token.",
        unlock_pressure_ratio: 0,
        volume_impact_ratio: 0,
        supply_inflation_percent: 0,
        risk_score: 0,
      });
    }

    const data = supplyResult.data as SupplyRiskOutputFlat & { status?: string; analysis_scope?: string };
    if (data.status === "unsupported_chain" && data.analysis_scope !== "scheduled_unlock") {
      const unsupported = data as { message?: string; detected_chain?: string };
      return jsonRpcSuccess(id, {
        supported: false,
        classification: "UNSUPPORTED_CHAIN",
        message: unsupported.message ?? `Token runs on ${unsupported.detected_chain ?? "unsupported chain"}. Supported: ethereum, bsc, arbitrum, base.`,
        unlock_pressure_ratio: 0,
        volume_impact_ratio: 0,
        supply_inflation_percent: 0,
        risk_score: 0,
      });
    }

    const report = supplyRiskToUnlockReport(data);
    const result = toUnlockResult(report);
    if (!isValidUnlockResult(result)) {
      return jsonRpcError(id, -32603, "Internal result validation failed.");
    }
    logger.info({ tool: UNLOCK_TOOL_NAME, token_symbol: symbolNorm, risk_score: result.risk_score }, "MCP callTool success");
    return jsonRpcSuccess(id, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, message, token_symbol: symbolNorm }, "MCP analyze_token_unlock error");
    return jsonRpcError(
      id,
      -32000,
      message.includes("timed out") ? "Analysis timed out. Try again or use a different token." : `Unlock analysis failed: ${message}.`
    );
  }
}

async function handleAnalyzeTokenSupplyRisk(
  id: string | number | null,
  token: string,
  args: Record<string, unknown>,
  deps: UnlockIntelligenceDeps
): Promise<JsonRpcSuccess | JsonRpcErrorBody> {
  type ChainSlug = "ethereum" | "arbitrum" | "bsc" | "base";
  let chainSlug: ChainSlug | undefined =
    (args.chain === "ethereum" || args.chain === "arbitrum" || args.chain === "bsc" || args.chain === "base") ? (args.chain as ChainSlug) : undefined;
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
    // Unsupported chain response: pass through without full schema validation.
    const unsupported = data as { status?: string; analysis_scope?: string };
    if (unsupported.status === "unsupported_chain" && unsupported.analysis_scope === "unsupported") {
      logger.info("SUPPLY_HANDLER_RETURNING_UNSUPPORTED_CHAIN");
      return normalizeSupplyRiskResult(data, id);
    }
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

/**
 * Register SSE endpoint for MCP clients that expect text/event-stream (e.g. Context Protocol).
 * GET /mcp, GET /mcp/sse, GET /sse return Content-Type: text/event-stream when Accept requests it.
 */
function registerSseEndpoint(app: { get?: (path: string, ...handlers: RequestHandler[]) => void }): void {
  if (typeof app.get !== "function") return;
  const sseHandler: RequestHandler = (req: Request, res: Response): void => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const baseUrl = `${req.protocol}://${req.get("host") || "localhost"}`;
    res.write(`event: endpoint\ndata: ${JSON.stringify({ url: `${baseUrl}/mcp` })}\n\n`);

    const ping = setInterval(() => {
      try {
        res.write(`: ping ${Date.now()}\n\n`);
      } catch {
        clearInterval(ping);
      }
    }, 15000);

    req.on("close", () => clearInterval(ping));
  };
  app.get("/mcp/sse", sseHandler);
  app.get("/sse", sseHandler);
  app.get("/mcp", (req: Request, res: Response): void => {
    const accept = (req.get("Accept") || "").toLowerCase();
    if (accept.includes("text/event-stream")) {
      sseHandler(req, res);
      return;
    }
    res.status(200).json({
      ok: true,
      protocol: "mcp",
      message: "POST JSON-RPC: initialize, listTools (or tools/list), callTool (or tools/call). SSE: GET /mcp/sse",
    });
  });
}

export function registerMcpRoute(
  app: { post: (path: string, ...handlers: RequestHandler[]) => void; get?: (path: string, ...handlers: RequestHandler[]) => void },
  deps: UnlockIntelligenceDeps,
  middleware: RequestHandler[] = []
): void {
  registerSseEndpoint(app);
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