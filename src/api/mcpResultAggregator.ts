/**
 * Aggregates MCP tool responses into a single result.
 * Propagates JSON-RPC error code and message; never returns empty error {}.
 */

export interface JsonRpcErrorPayload {
  code: number;
  message: string;
}

export interface UnlockAnalysisResult {
  unlock_pressure_ratio: number;
  volume_impact_ratio: number;
  supply_inflation_percent: number;
  risk_score: number;
}

export type AnalyzeTokenUnlockResponse =
  | { result: UnlockAnalysisResult }
  | { error: JsonRpcErrorPayload };

export type AnalyzeTokenSupplyRiskResponse =
  | { result: unknown }
  | { error: JsonRpcErrorPayload };

export interface AggregatedError {
  tool: string;
  error: { code: number; message: string };
}

export interface AggregatedMcpResult {
  unlockAnalysis: UnlockAnalysisResult | null;
  supplyRisk: unknown | null;
  errors: AggregatedError[];
}

function isJsonRpcError(
  r: AnalyzeTokenUnlockResponse | AnalyzeTokenSupplyRiskResponse
): r is { error: JsonRpcErrorPayload } {
  return (
    r != null &&
    typeof r === "object" &&
    "error" in r &&
    r.error != null &&
    typeof r.error === "object" &&
    typeof (r.error as JsonRpcErrorPayload).code === "number" &&
    typeof (r.error as JsonRpcErrorPayload).message === "string"
  );
}

function normalizeError(err: JsonRpcErrorPayload): { code: number; message: string } {
  return {
    code: Number(err.code),
    message: typeof err.message === "string" ? err.message : String(err.message ?? "Unknown error"),
  };
}

const UNLOCK_TOOL = "analyze_token_unlock";
const SUPPLY_RISK_TOOL = "analyze_token_supply_risk";

/**
 * Aggregates unlock and supply-risk MCP responses into one result.
 * Preserves JSON-RPC error code and message; never returns error: {}.
 */
export function aggregateMcpResults(
  unlockResponse: AnalyzeTokenUnlockResponse | null | undefined,
  supplyRiskResponse: AnalyzeTokenSupplyRiskResponse | null | undefined
): AggregatedMcpResult {
  const errors: AggregatedError[] = [];
  let unlockAnalysis: UnlockAnalysisResult | null = null;
  let supplyRisk: unknown | null = null;

  if (unlockResponse != null) {
    if (isJsonRpcError(unlockResponse)) {
      errors.push({
        tool: UNLOCK_TOOL,
        error: normalizeError(unlockResponse.error),
      });
    } else if ("result" in unlockResponse && unlockResponse.result != null) {
      unlockAnalysis = unlockResponse.result as UnlockAnalysisResult;
    }
  }

  if (supplyRiskResponse != null) {
    if (isJsonRpcError(supplyRiskResponse)) {
      errors.push({
        tool: SUPPLY_RISK_TOOL,
        error: normalizeError(supplyRiskResponse.error),
      });
    } else if ("result" in supplyRiskResponse) {
      supplyRisk = supplyRiskResponse.result;
    }
  }

  return {
    unlockAnalysis,
    supplyRisk,
    errors,
  };
}
