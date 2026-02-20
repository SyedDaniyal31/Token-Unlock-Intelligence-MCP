import { EthereumRpcProvider } from "./ethereumRpcProvider.js";

/**
 * BSC (Binance Smart Chain) RPC provider. Same interface as ChainProvider.
 * Uses BSC_RPC_URL from env or chains.json.
 */
export class BscRpcProvider extends EthereumRpcProvider {
  constructor(rpcUrl?: string) {
    const url = (rpcUrl ?? process.env.BSC_RPC_URL ?? "").trim();
    super(url || "https://bsc-dataseed.binance.org");
  }
}
