import * as fs from "fs";
import * as path from "path";
import logger from "../../core/logger.js";
import type { ExchangeClusterType } from "../../core/types.js";

export interface ExchangeLabelEntry {
  addresses: string[];
  clusterTag: string;
  clusterType?: ExchangeClusterType;
  label?: string;
}

export type ExchangeLabelsMap = Record<string, ExchangeLabelEntry>;

const DEFAULT_CLUSTER_TYPE: ExchangeClusterType = "cex";

function getExchangeLabelsPath(): string {
  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, "data", "exchangeLabels.json"),
    path.join(cwd, "..", "data", "exchangeLabels.json"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return path.join(cwd, "data", "exchangeLabels.json");
}

/**
 * Load exchange labels from data/exchangeLabels.json at startup.
 */
export function loadExchangeLabels(): ExchangeLabelsMap {
  const filePath = getExchangeLabelsPath();
  if (!fs.existsSync(filePath)) {
    logger.warn({ filePath }, "exchangeLabels.json not found; using empty labels");
    return {};
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as unknown;
    if (data === null || typeof data !== "object") return {};
    const out: ExchangeLabelsMap = {};
    for (const [key, entry] of Object.entries(data)) {
      if (entry && typeof entry === "object" && Array.isArray((entry as ExchangeLabelEntry).addresses)) {
        const e = entry as ExchangeLabelEntry;
        const clusterType =
          e.clusterType && ["cex", "hot_wallet", "deposit_router"].includes(e.clusterType)
            ? (e.clusterType as ExchangeClusterType)
            : DEFAULT_CLUSTER_TYPE;
        out[key] = {
          addresses: e.addresses.map((a) => (a || "").toLowerCase().trim()).filter(Boolean),
          clusterTag: typeof e.clusterTag === "string" ? e.clusterTag : key,
          clusterType,
          label: typeof e.label === "string" ? e.label : key,
        };
      }
    }
    return out;
  } catch (err) {
    logger.error({ err, filePath }, "Failed to load exchangeLabels.json");
    return {};
  }
}
