import type { ChainProvider, RawChainLog, RawChainBlock } from "../../core/types.js";

/**
 * Chain-agnostic RPC abstraction. Implementations wrap Ethers, Viem, or any RPC client.
 */
export type { ChainProvider, RawChainLog, RawChainBlock };
