/**
 * Multi-chain: returns ChainProvider by chainId or chainName.
 * All RPC via chainClient (tryRpcCall); no .rpc or legacy provider.
 */

import * as fs from "fs";
import * as path from "path";
import type { ChainProvider } from "../../core/types.js";
import { createChainProviderAdapter } from "../../services/unlockScanner/chainClient.js";
import { getRpcUrl } from "../../services/unlockScanner/chainClient.js";
import logger from "../../core/logger.js";

export type ChainId = string | number;

export interface ChainConfig {
  rpcUrl: string;
  chainId?: number;
}

export interface ChainsConfig {
  chains: Record<string, { rpcUrl: string; chainId?: number }>;
}

const DEFAULT_CHAIN = "ethereum";
const ENV_MAP: Record<string, string> = {
  ethereum: "ETH_RPC_URL",
  arbitrum: "ARB_RPC_URL",
  bsc: "BSC_RPC_URL",
};

function getChainsConfigPath(): string {
  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, "data", "chains.json"),
    path.join(cwd, "..", "data", "chains.json"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return path.join(cwd, "data", "chains.json");
}

function loadChainsConfig(): ChainsConfig {
  const filePath = getChainsConfigPath();
  if (!fs.existsSync(filePath)) {
    return { chains: {} };
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as unknown;
    if (data && typeof data === "object" && "chains" in data && data.chains && typeof data.chains === "object") {
      return data as ChainsConfig;
    }
  } catch (err) {
    logger.warn({ err, filePath }, "chains.json load failed");
  }
  return { chains: {} };
}

function resolveRpcUrl(chainKey: string, config?: { rpcUrl: string }): string {
  if (config?.rpcUrl && config.rpcUrl.startsWith("http")) return config.rpcUrl.trim();
  const key = chainKey.toLowerCase();
  const envKey = ENV_MAP[key] ?? `${chainKey.toUpperCase()}_RPC_URL`;
  let fromEnv = process.env[envKey];
  if (key === "ethereum" && (!fromEnv || !String(fromEnv).trim())) {
    fromEnv = process.env.RPC_URL;
  }
  if (fromEnv && typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
  return "";
}

const configCache: { config: ChainsConfig; ts: number } = { config: { chains: {} }, ts: 0 };
const CACHE_TTL_MS = 5 * 60 * 1000;

function getConfig(): ChainsConfig {
  if (Date.now() - configCache.ts < CACHE_TTL_MS && Object.keys(configCache.config.chains).length > 0) {
    return configCache.config;
  }
  configCache.config = loadChainsConfig();
  configCache.ts = Date.now();
  return configCache.config;
}

const providerCache = new Map<string, ChainProvider>();

const CHAIN_KEYS = ["ethereum", "arbitrum", "bsc"] as const;
type ChainKey = (typeof CHAIN_KEYS)[number];

function toChainKey(chainIdOrName: ChainId): ChainKey {
  const key = String(chainIdOrName).toLowerCase();
  if (key === "1" || key === "ethereum") return "ethereum";
  if (key === "42161" || key === "arbitrum") return "arbitrum";
  if (key === "56" || key === "bsc") return "bsc";
  return "ethereum";
}

/**
 * Returns ChainProvider for the given chain (chainId or chainName).
 * All RPC goes through chainClient (getRpcUrl + tryRpcCall). No .rpc anywhere.
 */
export function getChainProvider(chainIdOrName: ChainId): ChainProvider {
  const chainKey = toChainKey(chainIdOrName);

  const cached = providerCache.get(chainKey);
  if (cached) return cached;

  const provider: ChainProvider = createChainProviderAdapter(chainKey);
  providerCache.set(chainKey, provider);
  return provider;
}

/**
 * Returns all configured chain keys (ethereum, arbitrum, bsc, etc.).
 */
export function getConfiguredChains(): string[] {
  const config = getConfig();
  const keys = Object.keys(config.chains);
  if (keys.length > 0) return keys;
  if (process.env.ETH_RPC_URL) return [DEFAULT_CHAIN];
  if (process.env.ARB_RPC_URL) return ["arbitrum"];
  if (process.env.BSC_RPC_URL) return ["bsc"];
  return [DEFAULT_CHAIN];
}

/**
 * Returns which chains have an RPC URL configured (for diagnostics). Uses chainClient.getRpcUrl.
 */
export function getRpcConfigured(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const c of CHAIN_KEYS) {
    out[c] = getRpcUrl(c) != null;
  }
  return out;
}

/**
 * Clear provider cache (e.g. for tests or config reload).
 */
export function clearChainProviderCache(): void {
  providerCache.clear();
  configCache.ts = 0;
}
