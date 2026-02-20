# Phase 3: Vesting Contract Intelligence

Vesting-aware unlock detection: from generic log scanning to contract-type detection, precision events (release/claim/VestingReleased), and vesting_analysis for sellable supply refinement.

## 1. Vesting contract type detection

- **Module:** `src/ingestion/vestingDetector.ts`
- Uses optional `ChainProvider.call` (eth_call) with function selectors:
  - `release()`, `claim()`, `start()`, `cliff()`, `end()`
- Detected patterns stored in `unlock_schedules.vesting_type`:
  - `openzeppelin_token_vesting` — release + linear params + cliff
  - `linear_vesting` — linear params + release/claim
  - `cliff_vesting` — cliff + release/claim
  - `generic_vesting` — release or claim only
  - `unknown` — no call or no match

## 2. ABI pattern matching

- Selectors (4-byte) used for detection; VestingReleased/Released topic0 for event parsing.
- `isVestingReleasedTopic(topic0)` matches known release-event signatures.

## 3. Unlock event strategy

- **Linear:** `expectedVestedLinear(total, start, end, cliff, now)` — expected vested by current time; compared to claimed.
- **Cliff:** Before cliff timestamp expected = 0; after cliff, linear from start to end.

## 4. Precision unlock detection

- **unlockVerifier** parses:
  - **Transfer** (ERC20) — `event_type: "transfer"`, amount from data, recipient from topic2.
  - **VestingReleased** (or Released) — `event_type: "vest"`, amount from data, beneficiary from topic1.
- Inserts into `unlock_events`; claimed sum comes from all events for that contract.

## 5. vesting_analysis table

- **Schema:** `sql/migration_vesting_intelligence.sql` + `sql/migration_vesting_predictive.sql`
- **Columns:** token_symbol, contract_address, vesting_type, expected_vested, claimed_amount, remaining_locked, next_unlock_estimate, last_updated; **predictive:** vesting_rate_per_second, accelerated_claim, unlock_density, vesting_confidence.
- **Upserted** after each verification run in `unlockVerifier` (using total claimed, linear/cliff expected_vested, and predictive metrics from `vestingPredictive.ts`).

## 6. Sellable supply integration

- `computeSellableSupply()` fetches `vesting_analysis` and returns optional `expected_vested`, `remaining_locked`, **expected_vested_24h** (next_unlock_estimate), **vesting_type**.
- Pipeline uses **expected_vested** as denominator for **unlock_percent_supply** when available (refines unlock_percent_circulating).

## 7. Predictive vesting engine

- **Vesting rate:** `vesting_rate_per_second = total_allocation / (end - start)` for linear; stored in vesting_analysis.
- **Next unlock forecast:** Linear → `rate * 86400` (24h); cliff future → cliff release size; cliff past → linear from cliff. Replaces/supplements simple remaining-based estimate.
- **Acceleration:** `accelerated_claim = true` when `claimed > expected_vested * 1.05`.
- **Unlock density:** `unlock_density = claimed_amount / (end - start in days)`; higher = higher sell risk.
- **Vesting confidence:** 1.0 (linear/OZ), 0.7 (generic/cliff), 0.3 (unknown).
- **Impact scoring:** When `vesting_type === linear_vesting` (or openzeppelin_token_vesting), impact is weighted by **expected_vested_24h / circulating_supply** instead of only the claimed batch (predictive sell pressure).

## Example vesting analysis object

See `docs/example_vesting_analysis.json`:

- token_symbol, contract_address, vesting_type, expected_vested, claimed_amount, remaining_locked, next_unlock_estimate, last_updated
- **Predictive:** vesting_rate_per_second, accelerated_claim, unlock_density, vesting_confidence

## RPC layer

- **No breaking changes.** Optional `call?(to, data)` added to `ChainProvider`; implemented in `EthereumRpcProvider` and `MockEthereumProvider`. If `call` is absent, vesting type stays `unknown` and behavior remains as before.
