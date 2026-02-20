import { EthereumRpcProvider } from "./ethereumRpcProvider.js";

/**
 * Arbitrum One RPC provider. Same interface as ChainProvider.
 * Uses ARB_RPC_URL from env or chains.json.
 */
export class ArbitrumRpcProvider extends EthereumRpcProvider {
  constructor(rpcUrl?: string) {
    const url = (rpcUrl ?? process.env.ARB_RPC_URL ?? "").trim();
    super(url || "https://arb1.arbitrum.io/rpc");
  }
}
