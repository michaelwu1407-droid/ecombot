import * as Sentry from '@sentry/nextjs';

/**
 * Error reporting (BUILD_SPEC §4.7 step 10).
 *
 * Initialised only when a DSN is present, so local development and tests are not
 * reporting to anything. Two things are scrubbed before anything leaves:
 * credentials, and the text of customer messages — we are handling other
 * people's shoppers' conversations, and an error report is not a reason to copy
 * them to a third party.
 */

export function register(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,
    // Off by default: a shopper's DM is not ours to send anywhere.
    sendDefaultPii: false,

    beforeSend(event) {
      return scrub(event) as typeof event;
    },
  });
}

const SENSITIVE_KEYS =
  /(token|secret|key|password|authorization|credential|signature|content|draft|text|message)/i;

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (Array.isArray(value)) return value.map((entry) => scrub(entry, depth + 1));
  if (typeof value !== 'object' || value === null) return value;

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SENSITIVE_KEYS.test(key) ? '[redacted]' : scrub(entry, depth + 1);
  }
  return result;
}

export const onRequestError = Sentry.captureRequestError;
