/**
 * Layer 2 — On-Chain Verification Engine.
 * Fetches vest/claim/transfer events via ChainProvider and persists to unlock_events.
 * Chain-agnostic; parsing is implementation-specific (mock returns no events).
 */

import { query } from "../db.js";
import logger from "../logger.js";
import { listUnlockSchedules, updateLastVerifiedBlock } from "./registry.js";
import { getDefaultChainProvider } from "./chainProvider.js";
import type { ParsedUnlockEvent, UnlockEventType } from "./types.js";

const INSERT_EVENT_SQL = `
INSERT INTO unlock_events (
  token_symbol, contract_address, event_type, amount, block_number, tx_hash, recipient_address, timestamp, processed
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE)
`;

/**
 * Parse raw chain logs into unlock events. Mock: returns empty array.
 * Production: decode contract ABI and map to claim/transfer/vest with amount.
 */
function parseLogsToEvents(
  _tokenSymbol: string,
  _contractAddress: string,
  _logs: Array<{ blockNumber: number; transactionHash: string; topics: string[]; data: string }>
): ParsedUnlockEvent[] {
  return [];
}

export async function verifyUnlocksOnChain(): Promise<{
  eventsInserted: number;
  schedulesProcessed: number;
}> {
  const schedules = await listUnlockSchedules();
  const provider = getDefaultChainProvider();
  let eventsInserted = 0;

  for (const schedule of schedules) {
    try {
      const fromBlock = Math.max(
        0,
        parseInt(schedule.last_verified_block ?? "0", 10)
      );
      const toBlock = fromBlock + 1000;
      const logs = await provider.getLogs(
        schedule.contract_address,
        fromBlock,
        toBlock
      );
      const events = parseLogsToEvents(
        schedule.token_symbol,
        schedule.contract_address,
        logs
      );

      for (const ev of events) {
        await query(INSERT_EVENT_SQL, [
          schedule.token_symbol,
          schedule.contract_address,
          ev.event_type,
          ev.amount,
          ev.block_number,
          ev.tx_hash,
          (ev as { recipient_address?: string }).recipient_address ?? null,
          ev.timestamp,
        ]);
        eventsInserted++;
      }

      const lastBlock = events.length > 0
        ? Math.max(...events.map((e) => e.block_number))
        : toBlock;
      await updateLastVerifiedBlock(
        schedule.token_symbol,
        schedule.contract_address,
        lastBlock
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({
        layer: "verification",
        token_symbol: schedule.token_symbol,
        contract_address: schedule.contract_address,
        error: message,
      });
    }
  }

  return { eventsInserted, schedulesProcessed: schedules.length };
}

export async function getUnprocessedEvents(): Promise<
  Array<{
    id: string;
    token_symbol: string;
    contract_address: string;
    event_type: string;
    amount: string;
    block_number: string;
    tx_hash: string | null;
    recipient_address: string | null;
    timestamp: Date | null;
  }>
> {
  const result = await query<{
    id: string;
    token_symbol: string;
    contract_address: string;
    event_type: string;
    amount: string;
    block_number: string;
    tx_hash: string | null;
    recipient_address: string | null;
    timestamp: Date | null;
  }>(
    `SELECT id, token_symbol, contract_address, event_type, amount, block_number, tx_hash, recipient_address, timestamp
     FROM unlock_events WHERE processed = FALSE ORDER BY block_number ASC`
  );
  return result.rows;
}

const MARK_EVENT_PROCESSED_SQL = `
UPDATE unlock_events SET processed = TRUE WHERE id = $1
`;

export async function markEventProcessed(eventId: string): Promise<void> {
  await query(MARK_EVENT_PROCESSED_SQL, [eventId]);
}
