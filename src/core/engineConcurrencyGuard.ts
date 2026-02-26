/**
 * Global execution limiter for dynamic supply engine to prevent heap exhaustion
 * under concurrent MCP tool requests.
 */

import logger from "./logger.js";

export const MAX_DYNAMIC_ENGINE_CONCURRENCY = 4;

const WAIT_TIMEOUT_MS = 500;

let activeDynamicEngines = 0;
let waiterSeq = 0;
const waitQueue: Set<{ wake: () => void; seq: number }> = new Set();

/**
 * Acquire a slot before running the dynamic engine. Waits on a queue until a slot frees or timeout; throws if aborted or wait times out.
 * Returns a release handle: call it in finally so the slot is never leaked. Event-driven, FIFO by seq; timed-out/aborted waiters remove themselves.
 */
export async function acquireDynamicEngineSlot(
  signal?: AbortSignal
): Promise<() => void> {
  while (true) {
    if (signal?.aborted) {
      throw new Error("Dynamic engine aborted");
    }

    if (activeDynamicEngines < MAX_DYNAMIC_ENGINE_CONCURRENCY) {
      activeDynamicEngines += 1;

      let released = false;
      return () => {
        if (released) return;
        released = true;

        activeDynamicEngines = Math.max(0, activeDynamicEngines - 1);

        let nextEntry: { wake: () => void; seq: number } | undefined;
        for (const e of waitQueue) {
          if (!nextEntry || e.seq < nextEntry.seq) nextEntry = e;
        }
        if (nextEntry) {
          waitQueue.delete(nextEntry);
          nextEntry.wake();
        }
      };
    }

    await new Promise<void>((resolve, reject) => {
      const entry = { seq: waiterSeq++, wake: (() => {}) as () => void };
      entry.wake = () => {
        waitQueue.delete(entry);
        clearTimeout(timeout);
        resolve();
      };

      if (signal?.aborted) {
        return reject(new Error("Dynamic engine aborted"));
      }

      const timeout = setTimeout(() => {
        waitQueue.delete(entry);
        logger.warn(
          { activeDynamicEngines },
          "ENGINE_CONCURRENCY_WAIT_TIMEOUT"
        );
        reject(new Error("Dynamic engine busy"));
      }, WAIT_TIMEOUT_MS);

      waitQueue.add(entry);
    });
  }
}
