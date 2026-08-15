/**
 * Rate limiting on the webhook endpoint (BUILD_SPEC §4.7 step 10).
 *
 * A token bucket held in process memory, which on serverless means per instance
 * rather than global. That is a real limitation and it is the right trade anyway:
 *
 *   * The actual protection on this endpoint is the HMAC signature. Without the
 *     shared secret nothing reaches the parser, let alone the database.
 *   * What this guards against is a noisy or looping *legitimate* provider — a
 *     redelivery storm, a misconfigured subscription — where per-instance limits
 *     still shed the load.
 *   * The alternative is Redis, which §4.1 forbids, or a database round trip on
 *     the hot path of a five-second budget.
 *
 * Flag if a global limit ever becomes genuinely necessary. That is the point at
 * which the queue/Redis conversation is worth reopening.
 */

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();

/** Generous: a busy account can legitimately burst. */
const CAPACITY = 120;
const REFILL_PER_SECOND = 4;

/** Stops the map growing without bound on a long-lived instance. */
const MAX_BUCKETS = 5_000;

export function allowWebhook(key: string, now: number = Date.now()): boolean {
  if (buckets.size > MAX_BUCKETS) buckets.clear();

  const bucket = buckets.get(key) ?? { tokens: CAPACITY, lastRefill: now };

  const elapsedSeconds = Math.max(0, (now - bucket.lastRefill) / 1000);
  bucket.tokens = Math.min(CAPACITY, bucket.tokens + elapsedSeconds * REFILL_PER_SECOND);
  bucket.lastRefill = now;

  if (bucket.tokens < 1) {
    buckets.set(key, bucket);
    return false;
  }

  bucket.tokens -= 1;
  buckets.set(key, bucket);
  return true;
}

/** Test seam. */
export function resetWebhookLimits(): void {
  buckets.clear();
}
