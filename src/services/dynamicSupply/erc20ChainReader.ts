/**
 * ERC-20 / BEP-20 chain reads via eth_call: totalSupply, decimals, symbol, name.
 * Used by dynamic supply engine for any token address. No ABI dependency.
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

/** Decode ABI-encoded string from eth_call return: dynamic string (offset+length+data) or bytes32. */
function decodeStringFromHex(hex: string): string {
  if (!hex || typeof hex !== "string") return "";
  const raw = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (raw.length < 64) return "";
  try {
    const offsetBytes = parseInt(raw.slice(0, 64), 16);
    if (Number.isNaN(offsetBytes) || offsetBytes < 0) return decodeBytes32(raw.slice(0, 64));
    const dataStart = offsetBytes * 2;
    if (raw.length < dataStart + 64) return decodeBytes32(raw.slice(0, 64));
    const len = parseInt(raw.slice(dataStart, dataStart + 64), 16);
    if (Number.isNaN(len) || len < 0 || len > 1024) return decodeBytes32(raw.slice(0, 64));
    const dataHex = raw.slice(dataStart + 64, dataStart + 64 + len * 2);
    return decodeUtf8Hex(dataHex);
  } catch {
    return decodeBytes32(raw.slice(0, 64));
  }
}

function decodeBytes32(hex64: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < hex64.length; i += 2) {
    const b = parseInt(hex64.slice(i, i + 2), 16);
    if (b === 0) break;
    if (b >= 32 && b < 127) bytes.push(b);
  }
  return String.fromCharCode(...bytes);
}

function decodeUtf8Hex(hex: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
  } catch {
    return "";
  }
}

const SELECTOR_TOTAL_SUPPLY = "0x18160ddd";
const SELECTOR_DECIMALS = "0x313ce567";
const SELECTOR_SYMBOL = "0x95d89b41";
const SELECTOR_NAME = "0x06fdde03";

export interface Erc20SupplySnapshot {
  totalSupply: number;
  decimals: number;
}

export interface Erc20Metadata {
  symbol: string;
  name: string;
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

/**
 * Read symbol() and name() from token contract. Returns empty strings on failure.
 */
export async function readErc20Metadata(
  chainProvider: ChainProvider,
  tokenAddress: string
): Promise<Erc20Metadata> {
  const addr = tokenAddress.startsWith("0x") ? tokenAddress : "0x" + tokenAddress;
  const call = chainProvider.call?.bind(chainProvider);
  if (!call) {
    return { symbol: "", name: "" };
  }
  const [symbolHex, nameHex] = await Promise.all([
    call(addr, SELECTOR_SYMBOL),
    call(addr, SELECTOR_NAME),
  ]);
  const symbol = decodeStringFromHex(typeof symbolHex === "string" ? symbolHex : "0x").trim().slice(0, 32);
  const name = decodeStringFromHex(typeof nameHex === "string" ? nameHex : "0x").trim().slice(0, 128);
  return { symbol: symbol || "", name: name || "" };
}

/**
 * Full token discovery: supply + decimals + symbol + name. Batched calls.
 */
export async function discoverToken(
  chainProvider: ChainProvider,
  tokenAddress: string
): Promise<Erc20SupplySnapshot & Erc20Metadata> {
  const [supply, meta] = await Promise.all([
    readErc20Supply(chainProvider, tokenAddress),
    readErc20Metadata(chainProvider, tokenAddress),
  ]);
  return { ...supply, ...meta };
}
