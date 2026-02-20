import { query } from "../infrastructure/database/postgres.js";
import type { TokenMetadata } from "../core/types.js";

const UPSERT_SCHEDULE_SQL = `
INSERT INTO unlock_schedules (
  token_symbol, contract_address, beneficiary_label, total_allocation,
  vesting_start, vesting_cliff, vesting_end, release_frequency,
  last_verified_block, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, NOW())
ON CONFLICT (token_symbol, contract_address)
DO UPDATE SET
  beneficiary_label = EXCLUDED.beneficiary_label,
  total_allocation = EXCLUDED.total_allocation,
  vesting_start = EXCLUDED.vesting_start,
  vesting_cliff = EXCLUDED.vesting_cliff,
  vesting_end = EXCLUDED.vesting_end,
  release_frequency = EXCLUDED.release_frequency,
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
  ]);
}

const LIST_SQL = `
SELECT id, token_symbol, contract_address, beneficiary_label, total_allocation,
       vesting_start, vesting_cliff, vesting_end, release_frequency,
       last_verified_block::TEXT, created_at, updated_at
FROM unlock_schedules
ORDER BY token_symbol, contract_address
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
  }));
}

export async function getScheduleByToken(tokenSymbol: string): Promise<TokenMetadata | null> {
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
  }>(
    `SELECT token_symbol, contract_address, beneficiary_label, total_allocation,
            vesting_start, vesting_cliff, vesting_end, release_frequency,
            last_verified_block::TEXT
     FROM unlock_schedules WHERE token_symbol = $1 LIMIT 1`,
    [tokenSymbol]
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
  };
}

const UPDATE_LAST_VERIFIED_SQL = `
UPDATE unlock_schedules
SET last_verified_block = $1, updated_at = NOW()
WHERE token_symbol = $2 AND contract_address = $3
`;

export async function updateLastVerifiedBlock(
  tokenSymbol: string,
  contractAddress: string,
  blockNumber: number
): Promise<void> {
  await query(UPDATE_LAST_VERIFIED_SQL, [blockNumber, tokenSymbol, contractAddress]);
}
