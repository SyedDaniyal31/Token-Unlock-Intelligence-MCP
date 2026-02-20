/**
 * Vesting intelligence storage: upsert vesting_analysis (expected_vested, claimed_amount,
 * remaining_locked, next_unlock_estimate) for sellable supply refinement.
 */

import { query } from "../infrastructure/database/postgres.js";
import type { VestingAnalysisRow } from "../core/types.js";

const UPSERT_SQL = `
INSERT INTO vesting_analysis (
  token_symbol, contract_address, chain_id, vesting_type, expected_vested, claimed_amount,
  remaining_locked, next_unlock_estimate, vesting_rate_per_second, accelerated_claim,
  unlock_density, vesting_confidence, last_updated
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
ON CONFLICT (token_symbol, contract_address, chain_id)
DO UPDATE SET
  vesting_type = EXCLUDED.vesting_type,
  expected_vested = EXCLUDED.expected_vested,
  claimed_amount = EXCLUDED.claimed_amount,
  remaining_locked = EXCLUDED.remaining_locked,
  next_unlock_estimate = EXCLUDED.next_unlock_estimate,
  vesting_rate_per_second = EXCLUDED.vesting_rate_per_second,
  accelerated_claim = EXCLUDED.accelerated_claim,
  unlock_density = EXCLUDED.unlock_density,
  vesting_confidence = EXCLUDED.vesting_confidence,
  last_updated = EXCLUDED.last_updated
`;

export interface UpsertVestingAnalysisInput {
  token_symbol: string;
  contract_address: string;
  chain_id?: string;
  vesting_type: string | null;
  expected_vested: number;
  claimed_amount: number;
  remaining_locked: number;
  next_unlock_estimate: number | null;
  vesting_rate_per_second?: number | null;
  accelerated_claim?: boolean;
  unlock_density?: number | null;
  vesting_confidence?: number;
}

export async function upsertVestingAnalysis(input: UpsertVestingAnalysisInput): Promise<void> {
  await query(UPSERT_SQL, [
    input.token_symbol,
    input.contract_address,
    input.chain_id ?? "ethereum",
    input.vesting_type,
    input.expected_vested,
    input.claimed_amount,
    input.remaining_locked,
    input.next_unlock_estimate,
    input.vesting_rate_per_second ?? null,
    input.accelerated_claim ?? false,
    input.unlock_density ?? null,
    input.vesting_confidence ?? 0.3,
  ]);
}

const VESTING_SELECT = `
  token_symbol, contract_address, chain_id, vesting_type, expected_vested, claimed_amount,
  remaining_locked, next_unlock_estimate, vesting_rate_per_second, accelerated_claim,
  unlock_density, vesting_confidence, last_updated
`;

function mapVestingRow(r: {
  token_symbol: string;
  contract_address: string;
  chain_id: string | null;
  vesting_type: string | null;
  expected_vested: string;
  claimed_amount: string;
  remaining_locked: string;
  next_unlock_estimate: string | null;
  vesting_rate_per_second: string | null;
  accelerated_claim: boolean;
  unlock_density: string | null;
  vesting_confidence: string | null;
  last_updated: Date;
}): VestingAnalysisRow {
  return {
    token_symbol: r.token_symbol,
    contract_address: r.contract_address,
    chain_id: r.chain_id ?? undefined,
    vesting_type: r.vesting_type,
    expected_vested: parseFloat(r.expected_vested) || 0,
    claimed_amount: parseFloat(r.claimed_amount) || 0,
    remaining_locked: parseFloat(r.remaining_locked) || 0,
    next_unlock_estimate: r.next_unlock_estimate != null ? parseFloat(r.next_unlock_estimate) : null,
    last_updated: r.last_updated,
    vesting_rate_per_second: r.vesting_rate_per_second != null ? parseFloat(r.vesting_rate_per_second) : null,
    accelerated_claim: r.accelerated_claim ?? false,
    unlock_density: r.unlock_density != null ? parseFloat(r.unlock_density) : null,
    vesting_confidence: r.vesting_confidence != null ? parseFloat(r.vesting_confidence) : 0.3,
  };
}

export async function getVestingAnalysis(
  tokenSymbol: string,
  contractAddress: string,
  chainId?: string
): Promise<VestingAnalysisRow | null> {
  const result = await query<{
    token_symbol: string;
    contract_address: string;
    chain_id: string | null;
    vesting_type: string | null;
    expected_vested: string;
    claimed_amount: string;
    remaining_locked: string;
    next_unlock_estimate: string | null;
    vesting_rate_per_second: string | null;
    accelerated_claim: boolean;
    unlock_density: string | null;
    vesting_confidence: string | null;
    last_updated: Date;
  }>(
    chainId
      ? `SELECT ${VESTING_SELECT} FROM vesting_analysis WHERE token_symbol = $1 AND contract_address = $2 AND chain_id = $3 LIMIT 1`
      : `SELECT ${VESTING_SELECT} FROM vesting_analysis WHERE token_symbol = $1 AND contract_address = $2 LIMIT 1`,
    chainId ? [tokenSymbol, contractAddress, chainId] : [tokenSymbol, contractAddress]
  );
  const r = result.rows[0];
  if (!r) return null;
  return mapVestingRow(r);
}

export async function getVestingAnalysisByToken(
  tokenSymbol: string,
  chainId?: string
): Promise<VestingAnalysisRow | null> {
  const result = await query<{
    token_symbol: string;
    contract_address: string;
    chain_id: string | null;
    vesting_type: string | null;
    expected_vested: string;
    claimed_amount: string;
    remaining_locked: string;
    next_unlock_estimate: string | null;
    vesting_rate_per_second: string | null;
    accelerated_claim: boolean;
    unlock_density: string | null;
    vesting_confidence: string | null;
    last_updated: Date;
  }>(
    chainId
      ? `SELECT ${VESTING_SELECT} FROM vesting_analysis WHERE token_symbol = $1 AND chain_id = $2 LIMIT 1`
      : `SELECT ${VESTING_SELECT} FROM vesting_analysis WHERE token_symbol = $1 LIMIT 1`,
    chainId ? [tokenSymbol, chainId] : [tokenSymbol]
  );
  const r = result.rows[0];
  if (!r) return null;
  return mapVestingRow(r);
}
