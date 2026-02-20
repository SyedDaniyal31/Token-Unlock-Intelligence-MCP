import type {
  ChainProvider,
  RawChainLog,
  RawChainBlock,
  TokenTransfer,
} from "../../core/types.js";

/**
 * Mock Ethereum/RPC provider. Returns no logs/transfers. Uses RPC_URL from env when provided.
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

  async getTokenTransfers(
    _tokenAddress: string,
    _fromBlock: number,
    _toBlock: number
  ): Promise<TokenTransfer[]> {
    return [];
  }

  async call(_to: string, _data: string): Promise<string> {
    return "0x";
  }
}
