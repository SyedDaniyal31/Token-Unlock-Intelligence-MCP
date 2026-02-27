/**
 * Chain capability matrix. Only these chains are supported for unlock/supply analysis.
 */

export type SupportedChain =
  | "ethereum"
  | "bsc"
  | "arbitrum"
  | "base";

export const SUPPORTED_CHAINS: SupportedChain[] = [
  "ethereum",
  "bsc",
  "arbitrum",
  "base",
];

export function isChainSupported(chain: string | undefined): boolean {
  if (!chain) return false;
  return (SUPPORTED_CHAINS as readonly string[]).includes(chain.toLowerCase());
}
