import type { ChainProvider, RawChainLog, RawChainBlock } from "../../core/types.js";

/**
 * Mock Ethereum/RPC provider for development. Returns no logs.
 * Replace with real implementation (e.g. ethers.JsonRpcProvider) for production.
 */
export class MockEthereumProvider implements ChainProvider {
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
