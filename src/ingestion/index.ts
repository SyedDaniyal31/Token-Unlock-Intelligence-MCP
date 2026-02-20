/**
 * Ingestion layer — canonical only.
 * Layer 1: Unlock Registry (JSON + DB)
 * Layer 2: On-Chain Verification
 * Layer 3: Flow Analysis
 */

export { syncUnlockRegistryToDb } from "../infrastructure/registry/unlockRegistryLoader.js";
export {
  registerUnlockSchedule,
  listUnlockSchedules,
  getScheduleByToken,
  updateLastVerifiedBlock,
} from "./unlockRegistry.js";
export type { RegisterScheduleInput } from "./unlockRegistry.js";
export {
  verifyUnlocksOnChain,
  getUnprocessedEvents,
  markEventProcessed,
} from "./unlockVerifier.js";
export {
  analyzeUnlockFlow,
  getTimeWindowBucket,
} from "./flowAnalyzer.js";
export type { UnlockEventForFlow } from "./flowAnalyzer.js";
