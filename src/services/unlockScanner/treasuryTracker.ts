/**
 * Treasury unlock detection: top holders (>3%), large outbound; balance drop >2% circulating.
 */

export interface TreasuryEvent {
  timestamp: number;
  amount: number;
}

export interface TreasuryTrackerResult {
  treasuryEvents: TreasuryEvent[];
  treasuryRiskScore: number;
  /** Addresses that qualified as top holders and had large outbound. */
  treasuryWallets: string[];
}

/**
 * Identify top holders by outbound volume (>3% supply); large single transfers as treasury releases.
 * Score 0-100 by share of supply released. Never throws.
 */
export function trackTreasury(
  transferLogs: Array<{ from: string; amount: number; timestamp: number }>,
  circulatingSupply: number,
  totalSupply: number
): TreasuryTrackerResult {
  const circ = Math.max(1, circulatingSupply);
  const total = Math.max(1, totalSupply);
  const threshold3 = total * 0.03;
  const threshold2Circ = circ * 0.02;

  const sentByFrom = new Map<string, number>();
  for (const log of transferLogs) {
    const from = log.from.toLowerCase();
    if (from === "0x0000000000000000000000000000000000000000") continue;
    sentByFrom.set(from, (sentByFrom.get(from) ?? 0) + log.amount);
  }

  const topHolders = new Set<string>();
  for (const [addr, sent] of sentByFrom) {
    if (sent >= threshold3) topHolders.add(addr);
  }

  const treasuryEvents: TreasuryEvent[] = [];
  const treasuryWallets: string[] = [];
  for (const log of transferLogs) {
    const from = log.from.toLowerCase();
    if (!topHolders.has(from)) continue;
    if (log.amount >= threshold2Circ) {
      treasuryEvents.push({ timestamp: log.timestamp, amount: log.amount });
      if (!treasuryWallets.includes(from)) treasuryWallets.push(from);
    }
  }

  const totalReleased = treasuryEvents.reduce((s, e) => s + e.amount, 0);
  const pctOfCirc = circ > 0 ? (totalReleased / circ) * 100 : 0;
  const treasuryRiskScore = Math.round(Math.min(100, Math.max(0, pctOfCirc * 5)));

  return {
    treasuryEvents,
    treasuryRiskScore,
    treasuryWallets,
  };
}
