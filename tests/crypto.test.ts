import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';

before(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
});

const { encrypt, decrypt, encryptCredentials, decryptCredentials, verifyHmacSha256Hex } = await import(
  '../lib/crypto'
);

describe('credential encryption', () => {
  test('round-trips a token', () => {
    const token = 'shpat_' + 'a'.repeat(32);
    assert.equal(decrypt(encrypt(token)), token);
  });

  test('produces different ciphertext each time', () => {
    // A deterministic ciphertext would leak which merchants share a token.
    assert.notEqual(encrypt('same'), encrypt('same'));
  });

  test('round-trips a credentials object, preserving shape', () => {
    const creds = { accessToken: 'shpat_abc', shopDomain: 'boutique.myshopify.com' };
    const encrypted = encryptCredentials(creds);
    assert.notEqual(encrypted.accessToken, creds.accessToken);
    assert.deepEqual(decryptCredentials(encrypted), creds);
  });

  test('rejects tampered ciphertext rather than returning garbage', () => {
    const encrypted = encrypt('secret');
    const raw = Buffer.from(encrypted, 'base64');
    raw[raw.length - 1] ^= 0xff;
    assert.throws(() => decrypt(raw.toString('base64')));
  });

  test('rejects truncated ciphertext', () => {
    assert.throws(() => decrypt(Buffer.from('short').toString('base64')));
  });

  test('rejects a key that is not 32 bytes', () => {
    const previous = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = Buffer.from('too short').toString('base64');
    assert.throws(() => encrypt('x'), /32 bytes/);
    process.env.ENCRYPTION_KEY = previous;
  });
});

describe('webhook signature verification', () => {
  const secret = 'whsec_test';
  const body = JSON.stringify({ id: 'evt_1', event: 'message.received' });
  const signature = createHmac('sha256', secret).update(body, 'utf8').digest('hex');

  test('accepts a correct signature', () => {
    assert.equal(verifyHmacSha256Hex(body, signature, secret), true);
  });

  test('accepts an uppercase signature', () => {
    assert.equal(verifyHmacSha256Hex(body, signature.toUpperCase(), secret), true);
  });

  test('rejects a missing signature', () => {
    assert.equal(verifyHmacSha256Hex(body, null, secret), false);
  });

  test('rejects a signature for different content', () => {
    assert.equal(verifyHmacSha256Hex(body + ' ', signature, secret), false);
  });

  test('rejects a signature made with the wrong secret', () => {
    const forged = createHmac('sha256', 'wrong').update(body, 'utf8').digest('hex');
    assert.equal(verifyHmacSha256Hex(body, forged, secret), false);
  });

  test('rejects a signature of the wrong length without throwing', () => {
    assert.equal(verifyHmacSha256Hex(body, 'abc', secret), false);
  });
});
