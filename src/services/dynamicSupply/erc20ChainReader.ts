/**
 * ERC-20 / BEP-20 chain reads via eth_call: totalSupply, decimals.
 * Used by dynamic supply engine for any token address.
 */

import type { ChainProvider } from "../../core/types.js";

const ZERO = BigInt(0);

function hexToBigInt(hex: string): bigint {
  if (!hex || typeof hex !== "string") return ZERO;
  const s = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]+$/.test(s)) return ZERO;
  try {
    return BigInt("0x" + s);
  } catch {
    return ZERO;
  }
}

const SELECTOR_TOTAL_SUPPLY = "0x18160ddd";
const SELECTOR_DECIMALS = "0x313ce567";

export interface Erc20SupplySnapshot {
  totalSupply: number;
  decimals: number;
}

/**
 * Read totalSupply() and decimals() from token contract. Returns zeros on failure.
 */
export async function readErc20Supply(
  chainProvider: ChainProvider,
  tokenAddress: string
): Promise<Erc20SupplySnapshot> {
  const addr = tokenAddress.startsWith("0x") ? tokenAddress : "0x" + tokenAddress;
  const call = chainProvider.call?.bind(chainProvider);
  if (!call) {
    return { totalSupply: 0, decimals: 0 };
  }
  const [totalSupplyHex, decimalsHex] = await Promise.all([
    call(addr, SELECTOR_TOTAL_SUPPLY),
    call(addr, SELECTOR_DECIMALS),
  ]);
  const totalSupplyRaw = hexToBigInt(totalSupplyHex);
  const decimalsRaw = hexToBigInt(decimalsHex);
  const decimals = Number(decimalsRaw);
  const decimalsSafe = Number.isFinite(decimals) && decimals >= 0 && decimals <= 255 ? decimals : 0;
  const divisor = 10 ** decimalsSafe;
  const totalSupply = divisor > 0 ? Number(totalSupplyRaw) / divisor : 0;
  return {
    totalSupply: Number.isFinite(totalSupply) && totalSupply >= 0 ? totalSupply : 0,
    decimals: decimalsSafe,
  };
}
