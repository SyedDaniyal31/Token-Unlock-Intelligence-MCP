/**
 * Chain-agnostic RPC abstraction for on-chain verification.
 * Implementations can wrap Ethers, Viem, or any RPC client.
 */

import type { ChainProvider, RawChainLog, RawChainBlock } from "./types.js";

/**
 * Mock provider for development and tests. Returns no logs and a stub block
 * so the pipeline runs without a real RPC. Replace with a real implementation
 * (e.g. EthersProvider wrapping ethers.JsonRpcProvider) for production.
 */
export class MockChainProvider implements ChainProvider {
  async getLogs(
    _contractAddress: string,
    _fromBlock: number,
    _toBlock: number
  ): Promise<RawChainLog[]> {
    return [];
  }

  async getBlock(blockNumber: number): Promise<RawChainBlock | null> {
    return {
      number: blockNumber,
      timestamp: Math.floor(Date.now() / 1000),
    };
  }
}

let defaultProvider: ChainProvider | null = null;

export function setDefaultChainProvider(provider: ChainProvider): void {
  defaultProvider = provider;
}

export function getDefaultChainProvider(): ChainProvider {
  if (!defaultProvider) {
    defaultProvider = new MockChainProvider();
  }
  return defaultProvider;
}
