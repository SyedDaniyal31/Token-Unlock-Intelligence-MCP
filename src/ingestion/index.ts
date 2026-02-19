/**
 * Premium Unlock Ingestion — 3-layer pipeline.
 * Layer 1: Unlock Metadata Registry
 * Layer 2: On-Chain Verification Engine
 * Layer 3: Exchange Flow / Sellable Supply Detection
 */

export { registerUnlockSchedule, listUnlockSchedules } from "./registry.js";
export { verifyUnlocksOnChain, getUnprocessedEvents, markEventProcessed } from "./verification.js";
export { analyzeUnlockFlow, computeRealSellableSupply } from "./flowAnalysis.js";
export { runUnlockIngestionPipeline } from "./pipeline.js";
export { setDefaultChainProvider, getDefaultChainProvider, MockChainProvider } from "./chainProvider.js";
export type {
  RegisterUnlockScheduleInput,
  RealSellableSupplyResult,
} from "./types.js";
export type { UnlockEventForFlow } from "./flowAnalysis.js";
