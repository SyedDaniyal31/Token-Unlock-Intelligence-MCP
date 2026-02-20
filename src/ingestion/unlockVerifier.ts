import type { ChainProvider } from "../core/types.js";
import type { ParsedUnlockEvent } from "../core/types.js";
import { query } from "../infrastructure/database/postgres.js";
import logger from "../core/logger.js";
import { listUnlockSchedules, updateLastVerifiedBlock } from "./unlockRegistry.js";

const INSERT_EVENT_SQL = `
INSERT INTO unlock_events (
  token_symbol, contract_address, event_type, amount, block_number, tx_hash, recipient_address, timestamp, processed
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE)
`;

function parseLogsToEvents(
  _tokenSymbol: string,
  _contractAddress: string,
  _logs: Array<{ blockNumber: number; transactionHash: string; topics: string[]; data: string }>
): ParsedUnlockEvent[] {
  return [];
}

export async function verifyUnlocksOnChain(chainProvider: ChainProvider): Promise<{
  eventsInserted: number;
  schedulesProcessed: number;
}> {
  const schedules = await listUnlockSchedules();
  let eventsInserted = 0;

  for (const schedule of schedules) {
    try {
      const fromBlock = Math.max(0, parseInt(schedule.last_verified_block ?? "0", 10));
      const toBlock = fromBlock + 1000;
      const logs = await chainProvider.getLogs(
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
          ev.recipient_address ?? null,
          ev.timestamp,
        ]);
        eventsInserted++;
      }

      const lastBlock =
        events.length > 0
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
    recipient_address: string | null;
  }>
> {
  const result = await query<{
    id: string;
    token_symbol: string;
    contract_address: string;
    event_type: string;
    amount: string;
    recipient_address: string | null;
  }>(
    `SELECT id, token_symbol, contract_address, event_type, amount, recipient_address
     FROM unlock_events WHERE processed = FALSE ORDER BY block_number ASC`
  );
  return result.rows;
}

export async function markEventProcessed(eventId: string): Promise<void> {
  await query(`UPDATE unlock_events SET processed = TRUE WHERE id = $1`, [eventId]);
}
