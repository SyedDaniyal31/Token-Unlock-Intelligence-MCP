import type { ExchangeRegistry, ExchangeInfo, ExchangeCluster } from "../../core/types.js";
import { loadExchangeLabels } from "./exchangeLabelsLoader.js";

const addressToLabel = new Map<string, string>();
const addressToClusterTag = new Map<string, string>();
const clusterTagToCluster = new Map<string, ExchangeCluster>();
const knownExchangeAddresses = new Set<string>();

function initFromLabels(): void {
  if (knownExchangeAddresses.size > 0) return;
  const labels = loadExchangeLabels();
  for (const [labelKey, entry] of Object.entries(labels)) {
    const tag = entry.clusterTag ?? labelKey;
    const clusterLabel = entry.label ?? labelKey;
    const clusterType = entry.clusterType ?? "cex";
    const addresses = entry.addresses;

    const cluster: ExchangeCluster = {
      clusterTag: tag,
      label: clusterLabel,
      addresses: [...addresses],
      clusterType,
    };
    clusterTagToCluster.set(tag, cluster);

    for (const addr of addresses) {
      const key = addr.toLowerCase().trim();
      if (!key) continue;
      knownExchangeAddresses.add(key);
      addressToLabel.set(key, clusterLabel);
      addressToClusterTag.set(key, tag);
    }
  }
}

/**
 * Institutional exchange registry: address → clusterTag, clusterTag → ExchangeCluster.
 * Cluster-level modeling (cex | hot_wallet | deposit_router).
 */
export class DefaultExchangeRegistry implements ExchangeRegistry {
  constructor() {
    initFromLabels();
  }

  isKnownExchangeAddress(address: string): boolean {
    initFromLabels();
    return knownExchangeAddresses.has(address.toLowerCase().trim());
  }

  isExchangeAddress(address: string): boolean {
    return this.isKnownExchangeAddress(address);
  }

  getExchangeLabel(address: string): string | null {
    initFromLabels();
    return addressToLabel.get(address.toLowerCase().trim()) ?? null;
  }

  getExchangeInfo(address: string, _chainId?: string): ExchangeInfo {
    initFromLabels();
    const key = address.toLowerCase().trim();
    const isExchange = knownExchangeAddresses.has(key);
    const exchangeLabel = addressToLabel.get(key) ?? null;
    const clusterTag = addressToClusterTag.get(key) ?? undefined;
    return {
      isExchange,
      ...(exchangeLabel ? { exchangeLabel } : {}),
      ...(clusterTag ? { clusterTag } : {}),
    };
  }

  getCluster(clusterTag: string): ExchangeCluster | null {
    initFromLabels();
    return clusterTagToCluster.get(clusterTag) ?? null;
  }
}
