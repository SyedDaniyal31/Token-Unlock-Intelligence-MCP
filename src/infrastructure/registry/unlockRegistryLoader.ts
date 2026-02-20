import * as fs from "fs";
import * as path from "path";
import { registerUnlockSchedule } from "../../ingestion/unlockRegistry.js";
import logger from "../../core/logger.js";

export interface UnlockRegistryEntry {
  token_symbol: string;
  contract_address: string;
  vesting_contract: string;
  beneficiary_type: string;
  total_allocation: number;
  vesting_start: string | null;
  vesting_cliff: string | null;
  vesting_end: string | null;
  release_frequency: string;
  /** Chain key: ethereum | arbitrum | bsc (default ethereum) */
  chain_id?: string;
}

function getRegistryPath(): string {
  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, "data", "unlockRegistry.json"),
    path.join(cwd, "..", "data", "unlockRegistry.json"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return path.join(cwd, "data", "unlockRegistry.json");
}

export function loadUnlockRegistryFromDisk(): UnlockRegistryEntry[] {
  const filePath = getRegistryPath();
  if (!fs.existsSync(filePath)) {
    logger.warn({ filePath }, "unlockRegistry.json not found; using empty registry");
    return [];
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  const data = JSON.parse(raw) as unknown;
  if (!Array.isArray(data)) {
    logger.warn({ filePath }, "unlockRegistry.json must be an array");
    return [];
  }
  return data as UnlockRegistryEntry[];
}

export async function syncUnlockRegistryToDb(): Promise<number> {
  const entries = loadUnlockRegistryFromDisk();
  let synced = 0;
  for (const e of entries) {
    try {
      await registerUnlockSchedule({
        token_symbol: e.token_symbol,
        contract_address: e.contract_address,
        beneficiary_label: e.beneficiary_type,
        total_allocation: e.total_allocation,
        vesting_start: e.vesting_start ? new Date(e.vesting_start) : null,
        vesting_cliff: e.vesting_cliff ? new Date(e.vesting_cliff) : null,
        vesting_end: e.vesting_end ? new Date(e.vesting_end) : null,
        release_frequency: e.release_frequency ?? null,
        chain_id: e.chain_id ?? "ethereum",
      });
      synced++;
    } catch (err) {
      logger.error({ err, token_symbol: e.token_symbol }, "sync registry entry failed");
    }
  }
  if (synced > 0) {
    logger.info({ synced, total: entries.length }, "unlock registry synced to DB");
  }
  return synced;
}
