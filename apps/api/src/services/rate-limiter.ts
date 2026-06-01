// In-memory sliding-window rate limiter.
// Replaced the Redis sorted-set version to eliminate ~400+ Redis commands/day.
// Safe because we run a single process on Fly.io — no cross-process sync needed.
// On restart the window resets, but our caps are 20% below Meta's actual limits
// so the margin absorbs a cold start.

export const LIMITS = {
  instagram_total: { count: 80, windowMs: 24 * 3_600_000 },
  instagram_carousel: { count: 40, windowMs: 24 * 3_600_000 },
  threads_post: { count: 200, windowMs: 24 * 3_600_000 },
  threads_reply: { count: 800, windowMs: 24 * 3_600_000 },
} as const;

export type LimiterKind = keyof typeof LIMITS;

type CheckResult =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterMs: number; current: number; limit: number };

// Map<compositeKey, timestamp[]> — timestamps of consumed events.
const buckets = new Map<string, number[]>();

function keyFor(accountId: string, kind: LimiterKind): string {
  return `${accountId}:${kind}`;
}

/** Prune expired entries from a bucket and return the live list. */
function prune(key: string, windowMs: number, now: number): number[] {
  const entries = buckets.get(key);
  if (!entries) return [];
  const cutoff = now - windowMs;
  const live = entries.filter((t) => t > cutoff);
  if (live.length === 0) {
    buckets.delete(key);
  } else {
    buckets.set(key, live);
  }
  return live;
}

export async function checkAndConsume(
  accountId: string,
  kind: LimiterKind
): Promise<CheckResult> {
  const { count, windowMs } = LIMITS[kind];
  const now = Date.now();
  const key = keyFor(accountId, kind);
  const live = prune(key, windowMs, now);

  if (live.length >= count) {
    // Find oldest to compute retry-after.
    const oldest = Math.min(...live);
    const retryAfterMs = oldest + windowMs - now;
    return { allowed: false, retryAfterMs, current: live.length, limit: count };
  }

  // Consume a slot.
  live.push(now);
  buckets.set(key, live);
  return { allowed: true, remaining: count - live.length };
}

/**
 * Peek current usage without consuming. Useful for the dashboard / "remaining" widget.
 */
export async function usage(
  accountId: string,
  kind: LimiterKind
): Promise<{ used: number; limit: number; windowMs: number }> {
  const { count, windowMs } = LIMITS[kind];
  const now = Date.now();
  const live = prune(keyFor(accountId, kind), windowMs, now);
  return { used: live.length, limit: count, windowMs };
}
