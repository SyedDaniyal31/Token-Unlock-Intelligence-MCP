/**
 * Supply metrics aggregation for the multi-chain supply risk engine.
 * Collects total/circulating/max supply and allocation estimates from schedules and market data.
 */

import type { TokenMetadata } from "./types.js";

export interface SupplyMetrics {
  total_supply: number;
  circulating_supply: number;
  max_supply: number;
  team_allocation_pct: number;
  investor_allocation_pct: number;
  treasury_allocation_pct: number;
  /** Sum of unlock event amounts in timeframe (future scheduled from vesting). */
  upcoming_unlock_amount: number;
  /** 30d average volume USD from market. */
  avg_30d_volume_usd: number;
}

function pct(total: number, part: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, (part / total) * 100));
}

/** Infer allocation % from beneficiary_label when possible; otherwise return 0. */
function allocationFromLabel(
  label: string | null | undefined,
  totalAllocation: number
): { team: number; investor: number; treasury: number } {
  if (!totalAllocation || totalAllocation <= 0) return { team: 0, investor: 0, treasury: 0 };
  const l = (label ?? "").toLowerCase();
  if (l.includes("team") || l.includes("core")) return { team: 100, investor: 0, treasury: 0 };
  if (l.includes("investor") || l.includes("vc") || l.includes("advisor")) return { team: 0, investor: 100, treasury: 0 };
  if (l.includes("treasury") || l.includes("ecosystem") || l.includes("foundation")) return { team: 0, investor: 0, treasury: 100 };
  return { team: 33.33, investor: 33.33, treasury: 33.34 };
}

export function buildSupplyMetrics(
  metadata: TokenMetadata | null,
  circulatingSupply: number,
  upcomingUnlockAmount: number,
  avg30dVolumeUsd: number
): SupplyMetrics {
  const totalAllocation = metadata?.total_allocation ? parseFloat(String(metadata.total_allocation)) : 0;
  const { team, investor, treasury } = allocationFromLabel(metadata?.beneficiary_label, totalAllocation);
  const totalSupply = Math.max(circulatingSupply, totalAllocation);
  const maxSupply = totalSupply > 0 ? totalSupply : 0;

  return {
    total_supply: totalSupply,
    circulating_supply: Math.max(0, circulatingSupply),
    max_supply: maxSupply,
    team_allocation_pct: Number(team.toFixed(2)),
    investor_allocation_pct: Number(investor.toFixed(2)),
    treasury_allocation_pct: Number(treasury.toFixed(2)),
    upcoming_unlock_amount: Math.max(0, upcomingUnlockAmount),
    avg_30d_volume_usd: Math.max(0, avg30dVolumeUsd),
  };
}
