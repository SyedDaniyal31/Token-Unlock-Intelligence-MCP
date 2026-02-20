import type { ChainProvider } from "../core/types.js";
import type { ParsedUnlockEvent } from "../core/types.js";
import { query } from "../infrastructure/database/postgres.js";
import logger from "../core/logger.js";
import { listUnlockSchedules, updateLastVerifiedBlock, updateVestingType } from "./unlockRegistry.js";
import { detectVestingContract, isVestingReleasedTopic } from "./vestingDetector.js";
import { upsertVestingAnalysis } from "./vestingAnalysis.js";
import { computeVestingPredictive } from "./vestingPredictive.js";
import { getChainProvider } from "../infrastructure/rpc/chainProviderFactory.js";

const INSERT_EVENT_SQL = `
INSERT INTO unlock_events (
  token_symbol, contract_address, event_type, amount, block_number, tx_hash, recipient_address, timestamp, chain_id, processed
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, FALSE)
`;

/** ERC20 Transfer(address,address,uint256) topic0 */
const TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function parseUint256FromData(data: string): string {
  if (!data || data === "0x") return "0";
  const s = (data.startsWith("0x") ? data.slice(2) : data).replace(/^0+/, "") || "0";
  const padded = s.slice(-64);
  try {
    return String(BigInt("0x" + padded));
  } catch {
    return "0";
  }
}

function addressFromTopic(topic: string | undefined): string | null {
  if (!topic || typeof topic !== "string") return null;
  const s = topic.startsWith("0x") ? topic.slice(2) : topic;
  const padded = s.slice(-40);
  return "0x" + padded.padStart(40, "0").toLowerCase();
}

/**
 * Precision unlock detection: Transfer logs (release/claim flows) + VestingReleased events.
 * Produces ParsedUnlockEvent[] for DB insert.
 */
function parseLogsToEvents(
  _tokenSymbol: string,
  _contractAddress: string,
  logs: Array<{ blockNumber: number; transactionHash: string; topics: string[]; data: string }>
): ParsedUnlockEvent[] {
  const out: ParsedUnlockEvent[] = [];
  for (const log of logs) {
    const topic0 = log.topics?.[0];
    const blockNumber = log.blockNumber ?? 0;
    const txHash = log.transactionHash ?? "";
    const data = log.data ?? "0x";

    if (topic0?.toLowerCase() === TRANSFER_TOPIC0.toLowerCase()) {
      const to = addressFromTopic(log.topics?.[2]);
      const amount = parseUint256FromData(data);
      out.push({
        event_type: "transfer",
        amount,
        block_number: blockNumber,
        tx_hash: txHash,
        timestamp: new Date(0),
        recipient_address: to ?? undefined,
      });
      continue;
    }
    if (isVestingReleasedTopic(topic0)) {
      const beneficiary = addressFromTopic(log.topics?.[1]);
      const amount = parseUint256FromData(data);
      out.push({
        event_type: "vest",
        amount,
        block_number: blockNumber,
        tx_hash: txHash,
        timestamp: new Date(0),
        recipient_address: beneficiary ?? undefined,
      });
    }
  }
  return out;
}

/**
 * Linear vesting: expected_vested = total * (now - start) / (end - start) when now in [start,end].
 * With cliff: before cliff = 0; after cliff same linear from start to end.
 */
function expectedVestedLinear(
  totalAllocation: number,
  startTs: number | null,
  endTs: number | null,
  cliffTs: number | null,
  nowTs: number
): number {
  if (totalAllocation <= 0 || endTs == null || endTs <= 0) return 0;
  const start = startTs ?? 0;
  if (nowTs < start) return 0;
  if (cliffTs != null && cliffTs > 0 && nowTs < cliffTs) return 0;
  if (nowTs >= endTs) return totalAllocation;
  const duration = endTs - start;
  if (duration <= 0) return 0;
  return (totalAllocation * (nowTs - start)) / duration;
}

export type GetChainProvider = (chainId: string) => ChainProvider;

/**
 * Verify unlocks on chain. Uses getChainProvider(schedule.chain_id) per schedule for multi-chain.
 * If getProvider is omitted, uses chainProviderFactory.getChainProvider.
 * If a single ChainProvider is passed (legacy), that provider is used for all schedules.
 *
 * Concurrency: schedules are processed sequentially to avoid DB write races (inserts/updates
 * per schedule). Each chain provider applies its own rate limiting (e.g. 100ms per batch).
 */
export async function verifyUnlocksOnChain(
  chainProviderOrGetProvider?: ChainProvider | GetChainProvider
): Promise<{ eventsInserted: number; schedulesProcessed: number }> {
  const getProvider: GetChainProvider =
    typeof chainProviderOrGetProvider === "function"
      ? chainProviderOrGetProvider
      : chainProviderOrGetProvider != null
        ? () => chainProviderOrGetProvider as ChainProvider
        : (chainId: string) => getChainProvider(chainId);

  const schedules = await listUnlockSchedules();
  let eventsInserted = 0;

  for (const schedule of schedules) {
    const chainId = schedule.chain_id ?? "ethereum";
    const chainProvider = getProvider(chainId);

    try {
      if (chainProvider.call) {
        const detection = await detectVestingContract(schedule.contract_address, chainProvider);
        if (detection.vestingType !== "unknown") {
          await updateVestingType(schedule.token_symbol, schedule.contract_address, detection.vestingType, chainId);
        }
      }

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
          ev.timestamp.getTime() > 0 ? ev.timestamp : null,
          chainId,
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
        lastBlock,
        chainId
      );

      const totalAllocation = parseFloat(schedule.total_allocation) || 0;
      const claimedResult = await query<{ sum: string }>(
        `SELECT COALESCE(SUM(amount::numeric), 0) AS sum FROM unlock_events
         WHERE token_symbol = $1 AND contract_address = $2 AND chain_id = $3`,
        [schedule.token_symbol, schedule.contract_address, chainId]
      );
      const claimedAmount = parseFloat(claimedResult.rows[0]?.sum ?? "0") || 0;
      const startTs = schedule.vesting_start ? Math.floor(schedule.vesting_start.getTime() / 1000) : null;
      const endTs = schedule.vesting_end ? Math.floor(schedule.vesting_end.getTime() / 1000) : null;
      const cliffTs = schedule.vesting_cliff ? Math.floor(schedule.vesting_cliff.getTime() / 1000) : null;
      const nowTs = Math.floor(Date.now() / 1000);
      const expectedVested = expectedVestedLinear(totalAllocation, startTs, endTs, cliffTs, nowTs);
      const remainingLocked = Math.max(0, totalAllocation - claimedAmount);

      const predictive = computeVestingPredictive({
        total_allocation: totalAllocation,
        claimed_amount: claimedAmount,
        expected_vested: expectedVested,
        vesting_type: schedule.vesting_type ?? null,
        vesting_start: schedule.vesting_start ?? null,
        vesting_end: schedule.vesting_end ?? null,
        vesting_cliff: schedule.vesting_cliff ?? null,
      });
      const nextUnlockEstimate =
        predictive.next_unlock_estimate ??
        (remainingLocked > 0 && expectedVested > claimedAmount
          ? Math.min(remainingLocked, expectedVested - claimedAmount)
          : null);

      await upsertVestingAnalysis({
        token_symbol: schedule.token_symbol,
        contract_address: schedule.contract_address,
        chain_id: chainId,
        vesting_type: schedule.vesting_type ?? null,
        expected_vested: expectedVested,
        claimed_amount: claimedAmount,
        remaining_locked: remainingLocked,
        next_unlock_estimate: nextUnlockEstimate,
        vesting_rate_per_second: predictive.vesting_rate_per_second,
        accelerated_claim: predictive.accelerated_claim,
        unlock_density: predictive.unlock_density,
        vesting_confidence: predictive.vesting_confidence,
      });
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
    block_number: string | null;
    timestamp: Date | null;
    chain_id: string | null;
  }>
> {
  const result = await query<{
    id: string;
    token_symbol: string;
    contract_address: string;
    event_type: string;
    amount: string;
    recipient_address: string | null;
    block_number: string | null;
    timestamp: Date | null;
    chain_id: string | null;
  }>(
    `SELECT id, token_symbol, contract_address, event_type, amount, recipient_address,
            block_number::TEXT, timestamp, chain_id
     FROM unlock_events WHERE processed = FALSE ORDER BY block_number ASC`
  );
  return result.rows;
}

export async function markEventProcessed(eventId: string): Promise<void> {
  await query(`UPDATE unlock_events SET processed = TRUE WHERE id = $1`, [eventId]);
}
