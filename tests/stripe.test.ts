import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

before(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
});

const { signState, verifyState, STATE_TTL_MS } = await import('../lib/stripe/oauth-state');

describe('Stripe Connect OAuth state', () => {
  test('round-trips the merchant id', () => {
    const state = signState('merchant-123');
    assert.equal(verifyState(state), 'merchant-123');
  });

  test('is different every time, so a state cannot be replayed by guessing', () => {
    assert.notEqual(signState('m1'), signState('m1'));
  });

  test('rejects a forged state', () => {
    // The attack this stops: attaching your own Stripe account to someone else's
    // merchant record, and receiving their money.
    const forged = Buffer.from('victim-merchant.9999999999999.abcd.deadbeef').toString('base64url');
    assert.equal(verifyState(forged), null);
  });

  test('rejects a state whose merchant id was swapped', () => {
    const state = signState('merchant-123');
    const decoded = Buffer.from(state, 'base64url').toString('utf8');
    const tampered = decoded.replace('merchant-123', 'merchant-999');
    assert.equal(verifyState(Buffer.from(tampered).toString('base64url')), null);
  });

  test('rejects a state signed with a different key', () => {
    const state = signState('merchant-123');
    const previous = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
    assert.equal(verifyState(state), null);
    process.env.ENCRYPTION_KEY = previous;
  });

  test('expires after the TTL', () => {
    const issued = Date.now();
    const state = signState('merchant-123', issued);

    assert.equal(verifyState(state, issued + STATE_TTL_MS - 1_000), 'merchant-123');
    assert.equal(verifyState(state, issued + STATE_TTL_MS + 1_000), null);
  });

  test('rejects a state issued in the future', () => {
    const state = signState('merchant-123', Date.now() + 60_000);
    assert.equal(verifyState(state, Date.now()), null);
  });

  test('rejects malformed input without throwing', () => {
    assert.equal(verifyState(''), null);
    assert.equal(verifyState('not-base64!!!'), null);
    assert.equal(verifyState(Buffer.from('too.few.parts').toString('base64url')), null);
    assert.equal(verifyState(Buffer.from('...').toString('base64url')), null);
  });
});
