/**
 * Supply Shock Inference Layer: generate unlock intelligence when registry or
 * unlock scanner data is missing. Ensures unlock metrics are never null.
 *
 * Unlock intelligence hierarchy (priority):
 *   REGISTRY_UNLOCK > SCANNER_UNLOCK > INFERRED_SUPPLY_SHOCK
 * Inference is applied ONLY when unlock_data_available === false.
 * Inference never overwrites real unlock data.
 */

import { getUnlockPressureClassification, type UnlockPressureClassification } from "../core/quantitativeAnalytics.js";

/** Hierarchy: registry > scanner > inferred. */
export const UNLOCK_SOURCE_REGISTRY = "registry";
export const UNLOCK_SOURCE_SCANNER = "scanner";
export const UNLOCK_SOURCE_INFERRED = "inferred";

export type UnlockDataSource = typeof UNLOCK_SOURCE_REGISTRY | typeof UNLOCK_SOURCE_SCANNER | typeof UNLOCK_SOURCE_INFERRED;

export const INFERRED_UNLOCK_MODEL = "INFERRED_SUPPLY_SHOCK";
export const INFERENCE_SOURCE = "dynamic_supply_model";

export interface SupplyShockInferenceInput {
  inflation_rate_30d: number;
  supply_volatility_index: number;
  liquidity_stress_score: number;
  emission_trend: number;
  holder_data_confidence_score: number;
  /** True when liquidity (e.g. liquidity_usd or stress score) is available. */
  liquidity_data_available?: boolean;
  /** True when market enrichment (CoinGecko/DeFiLlama) was used. */
  market_enrichment_available?: boolean;
  /** 0–1: 1 = fresh block, 0 = no block or stale. */
  block_freshness_hint?: number;
}

export interface SupplyShockInferenceOutput {
  unlock_model: typeof INFERRED_UNLOCK_MODEL;
  unlock_pressure_classification: UnlockPressureClassification;
  confidence_score: number;
  inference_source: typeof INFERENCE_SOURCE;
  synthetic_unlock_pressure: number;
}

function fin(x: number): number {
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Compute synthetic unlock pressure from supply/market proxies when no unlock
 * scanner or registry data is available. Used so unlock metrics are never null.
 * Volatility is used for pressure only; not used in confidence.
 */
function computeSyntheticUnlockPressure(input: SupplyShockInferenceInput): number {
  const inf = clamp(fin(input.inflation_rate_30d) / 100, 0, 2);
  const vol = clamp(fin(input.supply_volatility_index) / 100, 0, 1);
  const liq = clamp(fin(input.liquidity_stress_score) / 100, 0, 1);
  const em = clamp((fin(input.emission_trend) + 10) / 20, 0, 1);
  const conf = clamp(fin(input.holder_data_confidence_score) / 100, 0, 1);
  const uncertainty = 1 - conf;
  const pressure = inf * 0.25 + vol * 0.2 + liq * 0.3 + em * 0.15 + uncertainty * 0.1;
  return clamp(pressure, 0, 2);
}

/**
 * Infer confidence in the synthetic unlock estimate (0–100).
 * Based on: holder_data_confidence_score, liquidity data availability,
 * market enrichment availability, block freshness. Volatility is not used.
 */
function computeInferenceConfidence(input: SupplyShockInferenceInput): number {
  const holderConf = clamp(fin(input.holder_data_confidence_score) / 100, 0, 1);
  const liquidityOk = input.liquidity_data_available === true ? 1 : 0;
  const enrichmentOk = input.market_enrichment_available === true ? 1 : 0;
  const blockFresh = clamp(fin(input.block_freshness_hint), 0, 1);
  const score = (holderConf * 0.4 + liquidityOk * 0.25 + enrichmentOk * 0.2 + blockFresh * 0.15) * 100;
  return Math.round(clamp(score, 0, 100));
}

/**
 * Run supply shock inference only when unlock_data_available === false.
 * Returns inferred unlock_model, unlock_pressure_classification, confidence_score,
 * inference_source, and synthetic_unlock_pressure. Never overwrites real unlock data.
 */
export function inferSupplyShockUnlock(input: SupplyShockInferenceInput): SupplyShockInferenceOutput {
  const synthetic_unlock_pressure = computeSyntheticUnlockPressure(input);
  const unlock_pressure_classification = getUnlockPressureClassification(synthetic_unlock_pressure);
  const confidence_score = computeInferenceConfidence(input);
  return {
    unlock_model: INFERRED_UNLOCK_MODEL,
    unlock_pressure_classification,
    confidence_score,
    inference_source: INFERENCE_SOURCE,
    synthetic_unlock_pressure,
  };
}

/**
 * Apply inference ONLY when unlock_data_available === false.
 * Hierarchy: REGISTRY_UNLOCK > SCANNER_UNLOCK > INFERRED_SUPPLY_SHOCK.
 * Caller must set unlock_data_available from real unlock data (registry or scanner).
 */
export function shouldApplySupplyShockInference(unlock_data_available: boolean): boolean {
  return unlock_data_available === false;
}
