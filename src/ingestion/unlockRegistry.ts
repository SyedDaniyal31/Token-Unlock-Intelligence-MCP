import { query } from "../infrastructure/database/postgres.js";
import type { TokenMetadata } from "../core/types.js";

const UPSERT_SCHEDULE_SQL = `
INSERT INTO unlock_schedules (
  token_symbol, contract_address, beneficiary_label, total_allocation,
  vesting_start, vesting_cliff, vesting_end, release_frequency,
  last_verified_block, chain_id, coingecko_id, paprika_id, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, $10, $11, NOW())
ON CONFLICT (token_symbol, contract_address, chain_id)
DO UPDATE SET
  beneficiary_label = EXCLUDED.beneficiary_label,
  total_allocation = EXCLUDED.total_allocation,
  vesting_start = EXCLUDED.vesting_start,
  vesting_cliff = EXCLUDED.vesting_cliff,
  vesting_end = EXCLUDED.vesting_end,
  release_frequency = EXCLUDED.release_frequency,
  coingecko_id = COALESCE(EXCLUDED.coingecko_id, unlock_schedules.coingecko_id),
  paprika_id = COALESCE(EXCLUDED.paprika_id, unlock_schedules.paprika_id),
  updated_at = EXCLUDED.updated_at
`;

export interface RegisterScheduleInput {
  token_symbol: string;
  contract_address: string;
  beneficiary_label: string;
  total_allocation: number;
  vesting_start?: Date | null;
  vesting_cliff?: Date | null;
  vesting_end?: Date | null;
  release_frequency?: string | null;
  chain_id?: string;
  coingecko_id?: string | null;
  paprika_id?: string | null;
}

export async function registerUnlockSchedule(input: RegisterScheduleInput): Promise<void> {
  await query(UPSERT_SCHEDULE_SQL, [
    input.token_symbol,
    input.contract_address,
    input.beneficiary_label,
    input.total_allocation,
    input.vesting_start ?? null,
    input.vesting_cliff ?? null,
    input.vesting_end ?? null,
    input.release_frequency ?? null,
    input.chain_id ?? "ethereum",
    input.coingecko_id ?? null,
    input.paprika_id ?? null,
  ]);
}

const LIST_SQL = `
SELECT id, token_symbol, contract_address, beneficiary_label, total_allocation,
       vesting_start, vesting_cliff, vesting_end, release_frequency,
       last_verified_block::TEXT, vesting_type, chain_id, coingecko_id, paprika_id, created_at, updated_at
FROM unlock_schedules
ORDER BY token_symbol, contract_address, chain_id
`;

export async function listUnlockSchedules(): Promise<TokenMetadata[]> {
  const result = await query<{
    id: string;
    token_symbol: string;
    contract_address: string;
    beneficiary_label: string;
    total_allocation: string;
    vesting_start: Date | null;
    vesting_cliff: Date | null;
    vesting_end: Date | null;
    release_frequency: string | null;
    last_verified_block: string | null;
    vesting_type: string | null;
    chain_id: string | null;
    coingecko_id: string | null;
    paprika_id: string | null;
    created_at: Date | null;
    updated_at: Date | null;
  }>(LIST_SQL);
  return result.rows.map((r) => ({
    token_symbol: r.token_symbol,
    contract_address: r.contract_address,
    beneficiary_label: r.beneficiary_label,
    total_allocation: r.total_allocation,
    vesting_start: r.vesting_start,
    vesting_cliff: r.vesting_cliff,
    vesting_end: r.vesting_end,
    release_frequency: r.release_frequency,
    last_verified_block: r.last_verified_block,
    vesting_type: r.vesting_type ?? undefined,
    chain_id: r.chain_id ?? "ethereum",
    coingecko_id: r.coingecko_id ?? undefined,
    paprika_id: r.paprika_id ?? undefined,
  }));
}

/**
 * Returns distinct chain_ids that have unlock activity for this token (events or schedules).
 * Used for multi-chain report breakdown and combined_score aggregation. Defaults omitted chain_id to ethereum in DB.
 */
export async function getChainIdsForToken(tokenSymbol: string): Promise<string[]> {
  const result = await query<{ chain_id: string | null }>(
    `(SELECT DISTINCT COALESCE(chain_id, 'ethereum') AS chain_id FROM unlock_events WHERE token_symbol = $1)
     UNION
     (SELECT DISTINCT COALESCE(chain_id, 'ethereum') AS chain_id FROM unlock_schedules WHERE token_symbol = $1)
     ORDER BY chain_id`,
    [tokenSymbol, tokenSymbol]
  );
  const ids = result.rows.map((r) => r.chain_id ?? "ethereum").filter(Boolean);
  return ids.length > 0 ? ids : ["ethereum"];
}

export interface UnlockEventRow {
  id: string;
  token_symbol: string;
  amount: string;
  timestamp: Date | null;
  chain_id: string | null;
}

/** Events for token in [since, until]; optional chainId. Used for historical unlock analysis. */
export async function getUnlockEventsInRange(
  tokenSymbol: string,
  since: Date,
  until?: Date,
  chainId?: string | null
): Promise<UnlockEventRow[]> {
  const untilVal = until ?? new Date();
  if (chainId != null && chainId !== "") {
    const result = await query<{ id: string; token_symbol: string; amount: string; timestamp: Date | null; chain_id: string | null }>(
      `SELECT id, token_symbol, amount, timestamp, chain_id FROM unlock_events
       WHERE token_symbol = $1 AND COALESCE(chain_id, 'ethereum') = $2 AND timestamp >= $3 AND timestamp <= $4 ORDER BY timestamp ASC`,
      [tokenSymbol, chainId, since, untilVal]
    );
    return result.rows;
  }
  const result = await query<{ id: string; token_symbol: string; amount: string; timestamp: Date | null; chain_id: string | null }>(
    `SELECT id, token_symbol, amount, timestamp, chain_id FROM unlock_events
     WHERE token_symbol = $1 AND timestamp >= $2 AND timestamp <= $3 ORDER BY timestamp ASC`,
    [tokenSymbol, since, untilVal]
  );
  return result.rows;
}

export async function getScheduleByToken(
  tokenSymbol: string,
  chainId?: string
): Promise<TokenMetadata | null> {
  const effectiveChainId = chainId ?? "ethereum";
  const result = await query<{
    token_symbol: string;
    contract_address: string;
    beneficiary_label: string;
    total_allocation: string;
    vesting_start: Date | null;
    vesting_cliff: Date | null;
    vesting_end: Date | null;
    release_frequency: string | null;
    last_verified_block: string | null;
    vesting_type: string | null;
    chain_id: string | null;
    coingecko_id: string | null;
    paprika_id: string | null;
  }>(
    `SELECT token_symbol, contract_address, beneficiary_label, total_allocation,
            vesting_start, vesting_cliff, vesting_end, release_frequency,
            last_verified_block::TEXT, vesting_type, chain_id, coingecko_id, paprika_id
     FROM unlock_schedules WHERE token_symbol = $1 AND chain_id = $2 LIMIT 1`,
    [tokenSymbol, effectiveChainId]
  );
  const r = result.rows[0];
  if (!r) return null;
  return {
    token_symbol: r.token_symbol,
    contract_address: r.contract_address,
    beneficiary_label: r.beneficiary_label,
    total_allocation: r.total_allocation,
    vesting_start: r.vesting_start,
    vesting_cliff: r.vesting_cliff,
    vesting_end: r.vesting_end,
    release_frequency: r.release_frequency,
    last_verified_block: r.last_verified_block,
    vesting_type: r.vesting_type ?? undefined,
    chain_id: r.chain_id ?? undefined,
    coingecko_id: r.coingecko_id ?? undefined,
    paprika_id: r.paprika_id ?? undefined,
  };
}

const UPDATE_LAST_VERIFIED_SQL = `
UPDATE unlock_schedules
SET last_verified_block = $1, updated_at = NOW()
WHERE token_symbol = $2 AND contract_address = $3 AND chain_id = $4
`;

export async function updateLastVerifiedBlock(
  tokenSymbol: string,
  contractAddress: string,
  blockNumber: number,
  chainId: string = "ethereum"
): Promise<void> {
  await query(UPDATE_LAST_VERIFIED_SQL, [blockNumber, tokenSymbol, contractAddress, chainId]);
}

const UPDATE_VESTING_TYPE_SQL = `
UPDATE unlock_schedules SET vesting_type = $1, updated_at = NOW()
WHERE token_symbol = $2 AND contract_address = $3 AND chain_id = $4
`;

export async function updateVestingType(
  tokenSymbol: string,
  contractAddress: string,
  vestingType: string,
  chainId: string = "ethereum"
): Promise<void> {
  await query(UPDATE_VESTING_TYPE_SQL, [vestingType, tokenSymbol, contractAddress, chainId]);
}
