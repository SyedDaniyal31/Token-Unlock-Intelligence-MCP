/** Supported chains for multi-chain supply risk engine. */
export type SupportedChainSlug = "ethereum" | "arbitrum" | "bsc";

export interface ChainConfig {
  chainId: string;
  displayName: string;
  numericId: number;
}

import * as ethereum from "./ethereum.js";
import * as arbitrum from "./arbitrum.js";
import * as bsc from "./bsc.js";

export const chains: Record<SupportedChainSlug, ChainConfig> = {
  ethereum: { chainId: ethereum.CHAIN_ID, displayName: ethereum.CHAIN_DISPLAY_NAME, numericId: ethereum.CHAIN_NUMERIC_ID },
  arbitrum: { chainId: arbitrum.CHAIN_ID, displayName: arbitrum.CHAIN_DISPLAY_NAME, numericId: arbitrum.CHAIN_NUMERIC_ID },
  bsc: { chainId: bsc.CHAIN_ID, displayName: bsc.CHAIN_DISPLAY_NAME, numericId: bsc.CHAIN_NUMERIC_ID },
};

export function toChainId(slug: SupportedChainSlug): string {
  return chains[slug].chainId;
}

export function isSupportedChain(slug: string): slug is SupportedChainSlug {
  return slug === "ethereum" || slug === "arbitrum" || slug === "bsc";
}
