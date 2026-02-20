# Real Ethereum RPC Execution Layer

## Overview

`EthereumRpcProvider` replaces the mock with a production-grade RPC layer that uses `RPC_URL`, batches block ranges, decodes ERC20 Transfer events, and stays safe for the ingestion pipeline.

## Provider Structure

- **File:** `src/infrastructure/rpc/ethereumRpcProvider.ts`
- **Class:** `EthereumRpcProvider implements ChainProvider`
- **Constructor:** Accepts `RPC_URL` from config/env; throws if missing in production (`NODE_ENV === "production"`).
- **Transport:** JSON-RPC via `fetch` (no heavy SDK).

## getLogs

- Uses `eth_getLogs` with `{ address, fromBlock, toBlock }`.
- **Batching:** If range > 5,000 blocks, splits into chunks of 5,000 and merges results.
- **Errors:** Logs failures and continues; returns partial results (or `[]`). Does not throw so the ingestion pipeline does not crash.
- **Rate limit:** 100 ms delay between batch requests.

## ERC20 Transfer Decoding

- **Topic0:** `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef` (keccak256 of `Transfer(address,address,uint256)`).
- **Helper:** `decodeTransferLog(log): TokenTransfer`
  - `from` = topic1 (padded to 40 hex chars)
  - `to` = topic2 (padded to 40 hex chars)
  - `value` = data (hex decoded to decimal string via BigInt; invalid/overflow → `"0"`).

## getTokenTransfers

- Calls `eth_getLogs` with `address = tokenAddress`, `topics = [TRANSFER_TOPIC]`.
- Batches block ranges > 5,000 blocks.
- Decodes each log with `decodeTransferLog` and returns `TokenTransfer[]`.
- Same error handling as `getLogs`: log and return partial results, no throw.

## Safety

- **Rate limit:** Delay between batch requests (`RPC_DELAY_MS = 100`).
- **Retries:** Up to 2 retries per RPC call (exponential backoff via delay).
- **Hex parsing:** `parseBlockNumber`, `parseValue` validate and fallback to 0 / "0" on invalid input.
- **BigInt:** `parseValue` uses try/catch; returns `"0"` on overflow or invalid data.
- **Production:** Constructor throws if `RPC_URL` is missing when `NODE_ENV === "production"`.

## Integration

- **App DI:** Uses `EthereumRpcProvider(rpcUrl)` when `RPC_URL` is set; otherwise `MockEthereumProvider`.
- **Tests:** Keep using `MockEthereumProvider` where no real RPC is needed.
- **Config:** `config.RPC_URL` or `process.env.RPC_URL`; in production, missing `RPC_URL` causes config/provider to throw.

## Example Decoded Transfer

```json
{
  "from": "0x1234567890123456789012345678901234567890",
  "to": "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
  "value": "1000000000000000000",
  "blockNumber": 18500000,
  "txHash": "0x..."
}
```

- `from` / `to`: 20-byte addresses from topic1/topic2 (padded).
- `value`: Raw uint256 from `data` as decimal string (e.g. 1e18 for 1 token with 18 decimals).
- `blockNumber`: From log block number (decimal).
- `txHash`: Transaction hash string.

## Performance Notes

- **Batching:** Ranges > 5,000 blocks are split to avoid RPC limits and timeouts.
- **Latency:** ~100 ms between batches to reduce rate-limit and throttling issues.
- **Idempotent:** Same (fromBlock, toBlock, address) always returns the same logs; ingestion can re-run safely.
- **Partial results:** On batch failure, already-fetched batches are returned so ingestion can make progress.
