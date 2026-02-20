import type {
  ChainProvider,
  RawChainLog,
  RawChainBlock,
  TokenTransfer,
} from "../../core/types.js";

/**
 * Chain-agnostic RPC abstraction. Implementations wrap Ethers, Viem, or any RPC client.
 * No business logic in provider; RPC_URL from env.
 */
export type { ChainProvider, RawChainLog, RawChainBlock, TokenTransfer };
