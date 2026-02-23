/**
 * Whale-like unlock spike: largest transfer vs 30d average volume → unlockPressureRatio.
 */

export interface TransferSpikeResult {
  largestTransfer: number;
  unlockPressureRatio: number;
}

/**
 * From transfer amounts, 30d volume (USD), and price at execution, compute largest transfer and unlockPressureRatio.
 * volume30dToken = priceAtExecution > 0 ? volume30dUsd / priceAtExecution : 0. If volume30dToken <= 0, ratio = 0.
 * No Date.now; price must be passed from caller (frozen at execution start). Never throws.
 */
export function analyzeTransferSpikes(
  transferAmounts: number[],
  volume30dUsd: number,
  priceAtExecution: number | undefined
): TransferSpikeResult {
  const largest = transferAmounts.length > 0 ? Math.max(...transferAmounts) : 0;
  const volUsd = Math.max(0, volume30dUsd);
  const price = priceAtExecution != null && Number.isFinite(priceAtExecution) && priceAtExecution > 0 ? priceAtExecution : 0;
  const volume30dToken = price > 0 ? volUsd / price : 0;
  const volToken = Math.max(0, volume30dToken);
  const unlockPressureRatio =
    volToken <= 0 || !Number.isFinite(volToken)
      ? 0
      : largest > 0 && Number.isFinite(largest)
        ? Math.max(0, largest / volToken)
        : 0;
  return {
    largestTransfer: Number.isFinite(largest) ? largest : 0,
    unlockPressureRatio: Number(Number(unlockPressureRatio).toFixed(4)),
  };
}
