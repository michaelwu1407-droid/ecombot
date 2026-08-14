import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { env } from './env';

/**
 * AES-256-GCM for `connections.credentials`. These are live Shopify and messaging
 * tokens for someone else's business — a leaked column should not be a leaked store.
 *
 * Wire format: base64(iv[12] || authTag[16] || ciphertext).
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;

function key(): Buffer {
  const raw = env.encryptionKey();
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error('ENCRYPTION_KEY must decode to 32 bytes (64 hex chars or base64 of 32 bytes)');
  }
  return buf;
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function decrypt(payload: string): string {
  const raw = Buffer.from(payload, 'base64');
  if (raw.length < IV_BYTES + TAG_BYTES) throw new Error('Ciphertext too short to be valid');
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** Encrypts each string value of a credentials object, leaving the shape intact. */
export function encryptCredentials(credentials: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(credentials).map(([k, v]) => [k, encrypt(v)]));
}

export function decryptCredentials(credentials: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(credentials).map(([k, v]) => [k, decrypt(v)]));
}

/** Constant-time comparison of a computed HMAC against a header value. */
export function verifyHmacSha256Hex(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const provided = signature.trim().toLowerCase();
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(provided, 'utf8'));
}
