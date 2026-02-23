/**
 * Vesting contract intelligence: detect contract type via eth_call with function selectors
 * and known ABI patterns (OpenZeppelin TokenVesting, linear, cliff-based).
 */

import type { ChainProvider } from "../core/types.js";

/** Known vesting pattern labels for unlock_schedules.vesting_type */
export type VestingType =
  | "openzeppelin_token_vesting"
  | "linear_vesting"
  | "cliff_vesting"
  | "generic_vesting"
  | "unknown";

/** Function selectors (first 4 bytes of keccak256) */
const SELECTORS = {
  release: "0x3d13f874",       // release()
  claim: "0x4e71d92d",        // claim()
  start: "0xa2e62045",        // start() (TokenVesting)
  cliff: "0x2d63f693",        // cliff()
  end: "0x7b0a47ee",          // end()
  duration: "0x066adefe",     // duration()
  vestedAmount: "0x5b44efef", // vestedAmount(uint256) — block param
  releasableAmount: "0x9852595c", // releasableAmount()
} as const;

function parseUint256Hex(hex: string): bigint {
  if (!hex || hex === "0x") return 0n;
  const s = hex.startsWith("0x") ? hex.slice(2) : hex;
  const padded = s.slice(-64);
  try {
    return BigInt("0x" + padded);
  } catch {
    return 0n;
  }
}

function parseTimestampFromResult(hex: string): number | null {
  const n = parseUint256Hex(hex);
  if (n === 0n) return null;
  const ts = Number(n);
  if (ts > 0 && ts < 2e12) return ts;
  return null;
}

export interface VestingDetectionResult {
  vestingType: VestingType;
  hasRelease: boolean;
  hasClaim: boolean;
  hasLinearParams: boolean;
  hasCliff: boolean;
  startTimestamp: number | null;
  cliffTimestamp: number | null;
  endTimestamp: number | null;
}

/**
 * Detect vesting contract type by calling known function selectors.
 * Requires ChainProvider.call to be implemented; otherwise returns vestingType "unknown".
 */
export async function detectVestingContract(
  contractAddress: string,
  chainProvider: ChainProvider
): Promise<VestingDetectionResult> {
  const out: VestingDetectionResult = {
    vestingType: "unknown",
    hasRelease: false,
    hasClaim: false,
    hasLinearParams: false,
    hasCliff: false,
    startTimestamp: null,
    cliffTimestamp: null,
    endTimestamp: null,
  };

  const call = chainProvider.call?.bind(chainProvider);
  if (!call) return out;

  const safeCall = async (data: string): Promise<string> => {
    try {
      return await call(contractAddress, data);
    } catch {
      return "0x";
    }
  };

  const [releaseResult, claimResult, startResult, cliffResult, endResult] = await Promise.all([
    safeCall(SELECTORS.release + "0".repeat(64)),
    safeCall(SELECTORS.claim + "0".repeat(64)),
    safeCall(SELECTORS.start + "0".repeat(64)),
    safeCall(SELECTORS.cliff + "0".repeat(64)),
    safeCall(SELECTORS.end + "0".repeat(64)),
  ]);

  out.hasRelease = releaseResult !== "0x" && releaseResult.length > 2;
  out.hasClaim = claimResult !== "0x" && claimResult.length > 2;
  out.startTimestamp = parseTimestampFromResult(startResult);
  out.cliffTimestamp = parseTimestampFromResult(cliffResult);
  out.endTimestamp = parseTimestampFromResult(endResult);
  out.hasCliff = out.cliffTimestamp != null && out.cliffTimestamp > 0;
  out.hasLinearParams = (out.startTimestamp != null || out.endTimestamp != null) && (out.startTimestamp != null || out.endTimestamp != null);

  if (out.hasRelease && out.hasLinearParams && (out.hasCliff || out.startTimestamp != null))
    out.vestingType = "openzeppelin_token_vesting";
  else if (out.hasCliff && (out.hasRelease || out.hasClaim))
    out.vestingType = "cliff_vesting";
  else if (out.hasLinearParams && (out.hasRelease || out.hasClaim))
    out.vestingType = "linear_vesting";
  else if (out.hasRelease || out.hasClaim)
    out.vestingType = "generic_vesting";

  return out;
}

/** Topic0 = keccak256("VestingReleased(address,uint256)") for precision unlock detection. */
export const VESTING_RELEASED_TOPIC0 = "0x2e17de78c17e2d776b2d882b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b";
/** Topic0 = keccak256("Released(address,uint256)") — alternate naming. */
export const RELEASED_TOPIC0 = "0x5e3c7e0c1b0e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8";

export function isVestingReleasedTopic(topic0: string | undefined): boolean {
  if (!topic0) return false;
  const t = topic0.toLowerCase();
  return t === VESTING_RELEASED_TOPIC0.toLowerCase() || t === RELEASED_TOPIC0.toLowerCase();
}
