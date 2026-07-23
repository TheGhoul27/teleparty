import type { Clock } from "./ids.js";

export interface RateLimitRule {
  windowMs: number;
  max: number;
}

export interface RateLimiter {
  /** Returns true when the action is allowed, false when rate limited. */
  consume(key: string, rule: RateLimitRule): boolean;
  dispose(): void;
}

interface Bucket {
  timestamps: number[];
}

/**
 * Sliding-window limiter. In-memory on purpose: signaling rate limits are
 * per-connection concerns and do not need to be shared across instances.
 */
export function createRateLimiter(clock: Clock): RateLimiter {
  const buckets = new Map<string, Bucket>();

  const sweep = setInterval(() => {
    const now = clock.now();
    for (const [key, bucket] of buckets) {
      bucket.timestamps = bucket.timestamps.filter((t) => now - t < 60 * 60 * 1000);
      if (bucket.timestamps.length === 0) buckets.delete(key);
    }
  }, 5 * 60 * 1000);
  sweep.unref?.();

  return {
    consume(key: string, rule: RateLimitRule): boolean {
      const now = clock.now();
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { timestamps: [] };
        buckets.set(key, bucket);
      }
      bucket.timestamps = bucket.timestamps.filter((t) => now - t < rule.windowMs);
      if (bucket.timestamps.length >= rule.max) return false;
      bucket.timestamps.push(now);
      return true;
    },
    dispose(): void {
      clearInterval(sweep);
      buckets.clear();
    }
  };
}

export const RATE_LIMIT_RULES = {
  roomCreatePerIp: { windowMs: 10 * 60 * 1000, max: 10 },
  joinAttemptPerIp: { windowMs: 60 * 1000, max: 15 },
  passwordAttemptPerRoom: { windowMs: 10 * 60 * 1000, max: 20 },
  chatPerParticipant: { windowMs: 10 * 1000, max: 8 },
  signalingPerParticipant: { windowMs: 10 * 1000, max: 120 }
} as const satisfies Record<string, RateLimitRule>;
