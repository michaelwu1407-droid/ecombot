import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../env';

/**
 * Signed `state` for the Stripe Connect OAuth round trip.
 *
 * Signed rather than stored: the value carries the merchant id and an HMAC over
 * it, so the callback can prove the merchant coming back is the one who left.
 * Without that, anyone who can reach the callback could attach their own Stripe
 * account to another merchant's record — and then receive their money.
 *
 * Reuses ENCRYPTION_KEY rather than adding another environment variable for a
 * fifteen-minute signature.
 */

export const STATE_TTL_MS = 15 * 60 * 1000;

export function signState(merchantId: string, now: number = Date.now()): string {
  const payload = `${merchantId}.${now}.${randomBytes(8).toString('hex')}`;
  const signature = createHmac('sha256', env.encryptionKey()).update(payload).digest('hex');
  return Buffer.from(`${payload}.${signature}`).toString('base64url');
}

export function verifyState(state: string, now: number = Date.now()): string | null {
  let decoded: string;
  try {
    decoded = Buffer.from(state, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const parts = decoded.split('.');
  if (parts.length !== 4) return null;

  const [merchantId, issuedAt, nonce, signature] = parts;
  if (!merchantId) return null;

  const expected = createHmac('sha256', env.encryptionKey())
    .update(`${merchantId}.${issuedAt}.${nonce}`)
    .digest('hex');

  if (signature.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;

  const age = now - Number.parseInt(issuedAt, 10);
  if (!Number.isFinite(age) || age < 0 || age > STATE_TTL_MS) return null;

  return merchantId;
}
