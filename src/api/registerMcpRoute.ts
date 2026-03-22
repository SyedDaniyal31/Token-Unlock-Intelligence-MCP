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
  scanRegistryHighImpactUnlocks,
  scanUpcomingUnlocks,
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
// Tool definitions: supply risk analysis + global registry scan
// ---------------------------------------------------------------------------

const SUPPLY_RISK_TOOL_NAME = "analyze_token_supply_risk";
const SCAN_UPCOMING_UNLOCKS_TOOL_NAME = "scan_upcoming_unlocks";

const MCP_TOOLS = [
  {
    name: SUPPLY_RISK_TOOL_NAME,
    description:
      "Comprehensive token unlock and supply risk engine. Includes scheduled unlock analysis, liquidity absorption modeling, and composite risk scoring. Use this tool for TITN-type queries, unlock event assessment, market impact analysis, severity classification, and risk tier. Supports Ethereum, Arbitrum, BSC, Base. Provide token_symbol for registry/calendar analysis, or token_address + chain for full on-chain analysis. This tool supersedes legacy unlock-only endpoints. Try asking: Analyze the upcoming unlock risk for HYPE; When is the next ENA token unlock?; Show upcoming unlock events for ARB; Analyze Jupiter (JUP) token unlock schedule; Which tokens have large unlocks in the next 30 days?; Analyze TIA and SUI token supply unlock risk.",
    inputSchema: {
      type: "object" as const,
      properties: {
        token_symbol: {
          type: "string" as const,
          description: "Token ticker for registry analysis (e.g. ETH, ARB). Omit when using token_address + chain for dynamic analysis.",
          examples: ["ARB", "ETH", "UNI"],
        },
        token_address: { type: "string" as const, description: "Contract address for dynamic analysis (use with chain)" },
        chain: {
          type: "string" as const,
          enum: ["ethereum", "arbitrum", "bsc", "base"] as const,
          description: "Chain to analyze; required when using token_address. Supported: ethereum, bsc, arbitrum, base.",
          default: "ethereum",
          examples: ["ethereum", "arbitrum", "bsc", "base"],
        },
        timeframe_days: {
          type: "number" as const,
          description: "Analysis window in days; default 30",
          default: 30,
          examples: [7, 30, 90],
        },
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
          description: "Machine-readable reason when no data was found (e.g. Unlock data unavailable across all sources). Indicates completed analysis, not infrastructure failure.",
        },
        message: {
          type: "string" as const,
          description: "User-facing message when no verified unlock schedule found (e.g. across TokenUnlocks, DefiLlama, or Messari).",
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
            unlock_percent_of_total_supply: { type: ["number", "null"] as const, description: "From manual registry; null when missing." },
            unlock_percent: { type: ["number", "null"] as const, description: "Alias for unlock_percent_of_total_supply (% of total supply)." },
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
        vesting_schedule: {
          type: "object" as const,
          description: "Parsed vesting schedule when unlock events exist. total_supply/circulating_supply and unlock_percent_of_circulating are null when supply is unknown.",
          properties: {
            token: { type: "string" as const },
            total_supply: { type: ["number", "null"] as const },
            circulating_supply: { type: ["number", "null"] as const },
            next_unlock_date: { type: ["string", "null"] as const },
            next_unlock_amount: { type: "number" as const },
            unlock_percent_of_circulating: { type: ["number", "null"] as const },
            unlock_percent_of_total_supply: { type: ["number", "null"] as const, description: "(next_unlock_amount / total_supply) * 100; null when supply unknown." },
            unlock_category: { type: "string" as const, enum: ["team", "investor", "ecosystem", "foundation", "unknown"] as const },
          },
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
  {
    name: SCAN_UPCOMING_UNLOCKS_TOOL_NAME,
    description:
      "Scan the full token registry (manual CSV + unlockRegistry.json) for upcoming unlocks in the next N days. Does not require token_symbol. Answers: Which tokens have large unlocks? Upcoming high impact token unlocks? What token unlocks should traders watch this month? Uses the same risk engine as analyze_token_supply_risk per token.",
    inputSchema: {
      type: "object" as const,
      properties: {
        days: {
          type: "number" as const,
          description: "Lookahead window in days for the next unlock (default 30).",
          default: 30,
          examples: [7, 30, 90],
        },
        limit: {
          type: "number" as const,
          description: "Optional max number of rows to return after sorting by unlock_percent.",
        },
      },
      required: [] as const,
      description: "Optional parameters only. Omit token_symbol — this tool scans all registry symbols.",
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        upcoming_unlocks: {
          type: "array" as const,
          description: "Tokens with next_unlock in window, unlock_percent > 0, sorted by unlock_percent DESC.",
          items: {
            type: "object" as const,
            properties: {
              symbol: { type: "string" as const },
              risk_tier: { type: "string" as const },
              severity: { type: "string" as const },
              unlock_date: { type: "string" as const },
              days_until: { type: "number" as const },
              unlock_percent: { type: "number" as const },
              volume_ratio_days: { type: "number" as const },
            },
          },
        },
      },
      required: ["upcoming_unlocks"] as const,
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
  const registryPct = typeof obj.registry_unlock_percent === "number" && Number.isFinite(obj.registry_unlock_percent as number)
    ? (obj.registry_unlock_percent as number) / 100
    : null;
  const supplyPct = typeof obj.supply_unlock_percent === "number" && Number.isFinite(obj.supply_unlock_percent as number)
    ? (obj.supply_unlock_percent as number)
    : null;
  const pct = registryPct ?? supplyPct ?? 0;
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
  const registryUnlockPercent =
    typeof obj.registry_unlock_percent === "number" && Number.isFinite(obj.registry_unlock_percent as number)
      ? Number((obj.registry_unlock_percent as number).toFixed(2))
      : null;
  const supplyUnlockPct = typeof obj.supply_unlock_percent === "number" && Number.isFinite(obj.supply_unlock_percent as number)
    ? (obj.supply_unlock_percent as number)
    : null;
  const unlockPercent =
    registryUnlockPercent != null
      ? registryUnlockPercent
      : supplyUnlockPct != null
        ? Number((supplyUnlockPct * 100).toFixed(2))
        : null;
  const unlockPercentOfTotalSupply =
    typeof obj.unlock_percent_of_total_supply === "number" && Number.isFinite(obj.unlock_percent_of_total_supply as number)
      ? Number((obj.unlock_percent_of_total_supply as number).toFixed(2))
      : null;
  const vestingTotalPct =
    obj.vesting_schedule != null &&
    typeof (obj.vesting_schedule as Record<string, unknown>).unlock_percent_of_total_supply === "number" &&
    Number.isFinite((obj.vesting_schedule as Record<string, unknown>).unlock_percent_of_total_supply as number)
      ? Number(((obj.vesting_schedule as Record<string, unknown>).unlock_percent_of_total_supply as number).toFixed(2))
      : null;
  if (unlockPercent == null && unlockPercentOfTotalSupply == null && vestingTotalPct == null) {
    console.warn("Unlock percent missing in manual registry");
  }
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
  const magnitudePct = unlockPercentOfTotalSupply ?? vestingTotalPct ?? unlockPercent;
  const eventDate = nextTs != null ? formatEventDate(nextTs) : null;
  const daysUntilUnlock = nextTs != null ? Math.max(0, Math.ceil((nextTs - now) / 86400)) : null;
  const volumeRatioDays = Number((unlockPressureRatio * 30).toFixed(1));
  const unlockPercentOfCirculating =
    obj.vesting_schedule != null &&
    typeof (obj.vesting_schedule as Record<string, unknown>).unlock_percent_of_circulating === "number" &&
    Number.isFinite((obj.vesting_schedule as Record<string, unknown>).unlock_percent_of_circulating as number)
      ? Number(
          ((obj.vesting_schedule as Record<string, unknown>)
            .unlock_percent_of_circulating as number).toFixed(2)
        )
      : null;

  out.unlock_event_assessment = {
    severity: riskLabels.event_severity_label,
    unlock_percent_of_total_supply: magnitudePct,
    /** Alias for unlock_percent_of_total_supply (registry % of supply, 0–100). */
    unlock_percent: magnitudePct,
    unlock_amount: unlockAmountUsd ?? null,
    unlock_date: eventDate,
    days_until_unlock: daysUntilUnlock,
    event_severity_label: riskLabels.event_severity_label,
    absorption_risk_label: riskLabels.absorption_risk_label,
    timing_urgency_label: riskLabels.timing_urgency_label,
    composite_score: riskLabels.composite_score,
    final_risk_tier: riskLabels.final_risk_tier,
  };

  const marketInterpretation = getMarketInterpretation(magnitudePct != null ? magnitudePct / 100 : 0);

  out.market_impact_analysis = {
    volume_ratio_days: volumeRatioDays,
    liquidity_absorption_classification: riskLabels.absorption_risk_label,
    market_interpretation: marketInterpretation,
  };

  const meetsMagnitudeThreshold =
    (magnitudePct != null && magnitudePct >= 5) ||
    volumeRatioDays >= 1 ||
    (unlockPercentOfCirculating != null && unlockPercentOfCirculating >= 1);
  const withinThirtyDays =
    daysUntilUnlock != null && Number.isFinite(daysUntilUnlock) && daysUntilUnlock >= 0 && daysUntilUnlock <= 30;
  (out as Record<string, unknown>).unlock_percent_of_supply = magnitudePct;
  (out as Record<string, unknown>).unlock_percent_of_circulating = unlockPercentOfCirculating;
  (out as Record<string, unknown>).has_large_30d_unlock =
    Boolean(meetsMagnitudeThreshold && withinThirtyDays);

  const lines: string[] = [];
  lines.push("=== Unlock Event Assessment ===");
  lines.push(`Severity: ${riskLabels.event_severity_label}`);
  lines.push(`Magnitude: ${magnitudePct != null ? `${magnitudePct}%` : "—"} of total supply`);
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

  const ratioForTier = unlockPercent != null ? unlockPercent / 100 : 0;
  const pctLabel = magnitudePct != null ? `${magnitudePct}%` : "—";
  if (ratioForTier >= 0.2 && nextTs != null) {
    out.analysis_summary = `A large supply expansion event of ${pctLabel} of total supply is scheduled for ${eventDate}. ${marketInterpretation}`;
  } else if (ratioForTier >= 0.1 && nextTs != null) {
    out.analysis_summary = `A significant supply expansion event of ${pctLabel} of total supply is scheduled for ${eventDate}. ${marketInterpretation}`;
  } else if (ratioForTier >= 0.05) {
    out.analysis_summary = `An elevated supply expansion event of ${pctLabel} of total supply is scheduled. ${marketInterpretation}`;
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

  if (obj.vesting_schedule != null && typeof obj.vesting_schedule === "object" && !Array.isArray(obj.vesting_schedule)) {
    out.vesting_schedule = obj.vesting_schedule;
  }

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
    const res = (response as JsonRpcSuccess).result as Record<string, unknown>;
    const skipInstitutionalSanitize =
      Array.isArray(res.upcoming_unlocks) || Array.isArray(res.registry_high_impact_unlocks);
    if (!skipInstitutionalSanitize) {
      (response as JsonRpcSuccess).result = sanitizeUserFacingOutput(res);
    }
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
    structuredContent: obj,
    isError: false,
  };
  return response;
}

// Keep under typical HTTP/MCP client timeouts (~30s) so we return before Context gives up.
const TOOL_TIMEOUT_MS = 25_000;

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

async function handleAnalyzeTokenSupplyRisk(
  id: string | number | null,
  token: string,
  args: Record<string, unknown>,
  deps: UnlockIntelligenceDeps
): Promise<JsonRpcSuccess | JsonRpcErrorBody> {
  const registryScan =
    (args as { registry_scan?: unknown }).registry_scan === true;
  if (registryScan) {
    try {
      const timeframeDays =
        typeof (args as { timeframe_days?: unknown }).timeframe_days === "number"
          ? ((args as { timeframe_days: number }).timeframe_days)
          : undefined;
      const limit =
        typeof (args as { limit?: unknown }).limit === "number"
          ? ((args as { limit: number }).limit)
          : undefined;
      const entries = await scanRegistryHighImpactUnlocks(deps, {
        timeframe_days: timeframeDays,
        limit,
      });
      return jsonRpcSuccess(id, {
        registry_high_impact_unlocks: entries,
      });
    } catch (err) {
      logger.error({ err }, "REGISTRY_HIGH_IMPACT_SCAN_FAILED");
      const softFailure = buildSoftFailureSupplyRisk("REGISTRY_SCAN_FAILED", 0);
      return jsonRpcSuccess(id, softFailure);
    }
  }
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

async function handleScanUpcomingUnlocks(
  id: string | number | null,
  args: Record<string, unknown>,
  deps: UnlockIntelligenceDeps
): Promise<JsonRpcSuccess | JsonRpcErrorBody> {
  const days = typeof args.days === "number" && Number.isFinite(args.days) && args.days > 0 ? args.days : 30;
  const limit =
    typeof args.limit === "number" && Number.isFinite(args.limit) && args.limit > 0 ? args.limit : undefined;
  try {
    const result = await scanUpcomingUnlocks(deps, { days, limit });
    return jsonRpcSuccess(id, result);
  } catch (err) {
    logger.error({ err }, "SCAN_UPCOMING_UNLOCKS_FAILED");
    return jsonRpcSuccess(id, { upcoming_unlocks: [] } as Record<string, unknown>);
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
  const registryScan =
    (args as { registry_scan?: unknown }).registry_scan === true;

  if (name === SCAN_UPCOMING_UNLOCKS_TOOL_NAME) {
    return handleScanUpcomingUnlocks(id, args, deps);
  }

  if (name === SUPPLY_RISK_TOOL_NAME) {
    if (tokenSymbol != null && typeof tokenSymbol !== "string") {
      return jsonRpcError(id, -32602, "Invalid params: token_symbol must be a string.");
    }
    if (!token && !tokenAddressArg && !registryScan) {
      logger.warn({ tool: name }, "MCP missing token_symbol or token_address");
      return jsonRpcError(id, -32602, "Missing required argument: token_symbol or token_address. For dynamic analysis provide token_address and chain.");
    }
    return handleAnalyzeTokenSupplyRisk(id, token, args, deps);
  }

  logger.warn({ name }, "MCP unknown tool");
  return jsonRpcError(
    id,
    -32602,
    `Unknown tool: ${name || "(missing)"}. Use ${SUPPLY_RISK_TOOL_NAME} or ${SCAN_UPCOMING_UNLOCKS_TOOL_NAME}.`
  );
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
      sseHandler(req, res, () => {});
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
    const requestId = req.body != null && typeof req.body === "object" && "id" in req.body ? (req.body as { id: unknown }).id ?? null : null;
    const errId = typeof requestId === "number" || typeof requestId === "string" ? requestId : null;

    const sendJsonRpc = (payload: JsonRpcSuccess | JsonRpcErrorBody): void => {
      if (res.headersSent) return;
      try {
        console.log("MCP POST responding");
        res.status(200).set("Content-Type", "application/json").json(payload);
      } catch (sendErr) {
        console.error("Unhandled MCP error: send failed", sendErr);
      }
    };

    const sendStructuredFailure = (error: string, error_code: string): void => {
      if (res.headersSent) return;
      try {
        console.log("MCP POST responding (error)");
        res.status(200).set("Content-Type", "application/json").json({
          jsonrpc: "2.0",
          id: errId,
          result: { success: false, error, error_code },
        });
      } catch (sendErr) {
        console.error("Unhandled MCP error: send failed", sendErr);
      }
    };

    try {
      const body = parseBody(req.body);
      const methodName = body != null && typeof body.method === "string" ? body.method : "";

      console.log("MCP POST received:", methodName || "(no method)");

      if (!body) {
        sendJsonRpc(jsonRpcError(null, -32600, "Invalid JSON-RPC request"));
        return;
      }
      if (body.jsonrpc !== "2.0") {
        sendJsonRpc(jsonRpcError(errId, -32600, "Invalid JSON-RPC request"));
        return;
      }

      const id = body.id ?? null;

      // listTools / tools/list: respond immediately, no DB, no async (avoids timeout)
      if (methodName === "listTools" || methodName === "tools/list") {
        sendJsonRpc(jsonRpcSuccess(id, { tools: MCP_TOOLS }));
        return;
      }

      // initialize: respond immediately
      if (methodName === "initialize") {
        sendJsonRpc(handleInitialize(id));
        return;
      }

      // Context lifecycle notifications (safe to ignore)
      if (methodName.startsWith("notifications/")) {
        sendJsonRpc({ jsonrpc: "2.0", id: null, result: null });
        return;
      }

      if (methodName === "") {
        sendJsonRpc(jsonRpcError(id, -32600, "Invalid Request: method is required."));
        return;
      }

      // All other methods: call handler then send (may be async). Never let handler throw.
      let response: JsonRpcSuccess | JsonRpcErrorBody;
      try {
        if (methodName === "callTool" || methodName === "tools/call") {
          response = await handleCallTool(id, body.params, deps);
        } else if (methodName === "analyze_token_supply_risk") {
          const args = parseArguments(body.params);
          const tokenSymbol = args.token_symbol ?? args.tokenSymbol ?? args.token;
          const token = (typeof tokenSymbol === "string" ? tokenSymbol : tokenSymbol != null ? String(tokenSymbol) : "").trim();
          response = await handleAnalyzeTokenSupplyRisk(id, token, args, deps);
        } else {
          try {
            logger.warn({ method: methodName }, "MCP method not found");
          } catch {
            /* ignore logger throw */
          }
          response = jsonRpcError(id, -32601, `Method not found: ${methodName}.`);
        }
      } catch (toolErr) {
        const msg = toolErr instanceof Error ? toolErr.message : String(toolErr);
        console.error("Unhandled MCP error:", toolErr);
        const isDb = /database|query|connection|ECONNREFUSED|timeout/i.test(msg);
        sendStructuredFailure(
          isDb ? "Database query failed" : "Internal server error",
          isDb ? "DB_QUERY_ERROR" : "INTERNAL_ERROR"
        );
        return;
      }

      if (!response || typeof response !== "object" || !("jsonrpc" in response)) {
        response = jsonRpcSuccess(id, buildSoftFailureSupplyRisk("INVALID_ROUTER_RESPONSE", 0));
      }
      if ("result" in response) {
        const r = (response as JsonRpcSuccess).result;
        if (r == null || Array.isArray(r) || typeof r !== "object") {
          response = jsonRpcSuccess(id, buildSoftFailureSupplyRisk("INVALID_RESULT_SHAPE", 0));
        } else if ("success" in r && "data" in r) {
          const inner = (r as { success: unknown; data: unknown }).data;
          response = jsonRpcSuccess(
            id,
            inner != null && typeof inner === "object" && !Array.isArray(inner)
              ? inner
              : buildSoftFailureSupplyRisk("EMPTY_DATA_GUARD", 0)
          );
        }
      }
      try {
        response = ensureFlatResultPayload(response, id);
      } catch {
        response = jsonRpcSuccess(id, buildSoftFailureSupplyRisk("INVALID_RESULT_SHAPE", 0));
      }
      if (
        (methodName === "callTool" || methodName === "tools/call") &&
        "result" in response &&
        (response as JsonRpcSuccess).result &&
        typeof (response as JsonRpcSuccess).result === "object" &&
        !Array.isArray((response as JsonRpcSuccess).result)
      ) {
        try {
          response = addToolsCallContentCompat(response);
        } catch {
          /* keep response as-is */
        }
      }
      if ("result" in response) {
        if (Array.isArray((response as JsonRpcSuccess).result) || (response as JsonRpcSuccess).result == null) {
          response = jsonRpcSuccess(id, buildSoftFailureSupplyRisk("FINAL_GUARD_ARRAY_BLOCKED", 0));
        }
      }
      try {
        logger.info({ id, method: methodName, hasResult: "result" in response }, "MCP POST result ready");
      } catch {
        /* ignore logger throw */
      }
      sendJsonRpc(response);
    } catch (err) {
      console.error("Unhandled MCP error:", err);
      if (!res.headersSent) {
        sendStructuredFailure("Internal server error", "INTERNAL_ERROR");
      }
    }
  };

  app.post("/mcp", ...middleware, handler);

  // Workaround: Context sometimes sends the full URL as the path (e.g. /%2Fhttps:%2F%2F...%2Fmcp).
  // Accept that path and run the same MCP handler so the tool connects while the dashboard URL is fixed.
  app.post("*", (req: Request, res: Response, next: () => void): void => {
    const path = (req.url ?? req.originalUrl ?? "").split("?")[0] ?? "";
    const pathDecoded = tryDecodeUriPath(path);
    const isMalformedMcpPath =
      (pathDecoded.includes("token-unlock-intelligence-mcp") && pathDecoded.includes("/mcp")) ||
      (path.includes("token-unlock-intelligence-mcp") && path.includes("mcp"));
    if (isMalformedMcpPath) {
      try {
        logger.warn({ path, pathDecoded }, "Context malformed path workaround: treating as POST /mcp");
      } catch {
        /* ignore */
      }
      void Promise.resolve(handler(req, res, () => {})).catch((err: unknown) => {
        console.error("Unhandled MCP error (malformed path workaround):", err);
      });
      return;
    }
    next();
  });
}

function tryDecodeUriPath(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return raw;
  }
}