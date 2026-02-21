/**
 * Token-bucket rate limiter for external APIs. Bounded queue, non-blocking, Promise-based.
 * Reusable for RPC, market, and future providers.
 */

export class RateLimiter {
  private readonly maxRequests: number;
  private readonly intervalMs: number;
  private readonly refillPerMs: number;
  private readonly maxQueueSize: number;
  private tokens: number;
  private lastRefillTs: number;
  private readonly queue: Array<() => void> = [];
  private nextRefillTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    maxRequests: number,
    intervalMs: number,
    maxQueueSize: number = 500
  ) {
    if (maxRequests < 1 || intervalMs < 1 || maxQueueSize < 1) {
      throw new Error("RateLimiter: maxRequests, intervalMs, and maxQueueSize must be positive");
    }
    this.maxRequests = maxRequests;
    this.intervalMs = intervalMs;
    this.refillPerMs = maxRequests / intervalMs;
    this.maxQueueSize = maxQueueSize;
    this.tokens = maxRequests;
    this.lastRefillTs = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillTs;
    this.tokens = Math.min(
      this.maxRequests,
      this.tokens + elapsed * this.refillPerMs
    );
    this.lastRefillTs = now;
  }

  private scheduleNextRefill(): void {
    if (this.nextRefillTimer != null || this.queue.length === 0) return;
    this.refill();
    if (this.tokens >= 1) {
      this.processQueue();
      return;
    }
    const needTokens = 1 - this.tokens;
    const waitMs = Math.ceil((needTokens / this.refillPerMs));
    this.nextRefillTimer = setTimeout(() => {
      this.nextRefillTimer = null;
      this.processQueue();
    }, Math.min(waitMs, this.intervalMs));
  }

  private processQueue(): void {
    this.refill();
    while (this.tokens >= 1 && this.queue.length > 0) {
      this.tokens -= 1;
      const resolve = this.queue.shift();
      if (resolve) resolve();
    }
    if (this.queue.length > 0) this.scheduleNextRefill();
  }

  /**
   * Acquire one token. Resolves when a token is available; rejects if queue is full.
   * Non-blocking; queued callers are released when tokens refill.
   */
  acquire(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        resolve();
        return;
      }
      if (this.queue.length >= this.maxQueueSize) {
        reject(new Error("Rate limiter queue full"));
        return;
      }
      this.queue.push(resolve);
      this.scheduleNextRefill();
    });
  }
}

/** Shared limiters for market providers. 20/min and 30/min. */
export const coingeckoLimiter = new RateLimiter(20, 60_000);
export const paprikaLimiter = new RateLimiter(30, 60_000);
