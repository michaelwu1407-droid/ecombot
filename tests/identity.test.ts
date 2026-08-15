import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { extractHandle, normaliseHandle, maskEmail } from '../lib/identity';

/**
 * The failure this code exists to avoid is not "we missed a match". It is telling
 * one shopper about another shopper's orders, from the merchant's own account.
 * Certain joins happen silently; likely joins get proposed; nothing is guessed.
 */

describe('finding a handle the merchant already wrote down', () => {
  test('reads a labelled handle from an order note', () => {
    // Boutiques who sell in DMs do this constantly. Free, unambiguous, and the
    // highest-yield tier precisely because nobody thinks to look.
    assert.equal(extractHandle('IG: @sarah_c'), 'sarah_c');
    assert.equal(extractHandle('ig @sarah_c'), 'sarah_c');
    assert.equal(extractHandle('Instagram — @sarah.c'), 'sarah.c');
    assert.equal(extractHandle('insta: sarah_c'), 'sarah_c');
  });

  test('reads it from anywhere in a longer note', () => {
    assert.equal(
      extractHandle('paid by bank transfer, IG: @sarah_c, wants it gift wrapped'),
      'sarah_c'
    );
  });

  test('reads a bare handle', () => {
    assert.equal(extractHandle('ordered via @sarah_c'), 'sarah_c');
  });

  test('does not mistake an email address for a handle', () => {
    // An email has an @ in it, and treating the domain as a handle would join two
    // unrelated people.
    assert.equal(extractHandle('contact sarah.chen@gmail.com'), null);
  });

  test('searches several sources at once', () => {
    assert.equal(extractHandle(null, undefined, 'vip', 'ig: @sarah_c'), 'sarah_c');
  });

  test('finds nothing when there is nothing', () => {
    assert.equal(extractHandle('gift wrap please'), null);
    assert.equal(extractHandle(''), null);
    assert.equal(extractHandle(null, undefined), null);
  });

  test('normalises so a match is not missed on case or a leading @', () => {
    assert.equal(normaliseHandle('@Sarah_C'), 'sarah_c');
    assert.equal(normaliseHandle('  SARAH_C '), 'sarah_c');
  });
});

describe('showing a past customer to the merchant', () => {
  test('shows enough to recognise them without printing the address', () => {
    const masked = maskEmail('sarah.chen@gmail.com');
    assert.match(masked, /^sa/);
    assert.match(masked, /@gmail\.com$/);
    assert.doesNotMatch(masked, /chen/);
  });

  test('handles a missing or malformed email without leaking anything', () => {
    assert.equal(maskEmail(null), 'a past customer');
    assert.equal(maskEmail('not-an-email'), 'a past customer');
  });
});
