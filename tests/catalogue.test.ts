import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { catalogueWarning, MAX_CATALOGUE_AGE_MS, type CatalogueState } from '../lib/catalogue';
import { decideRevival } from '../lib/proactive/eligibility';

/**
 * A stale catalogue is the quietest way for the agent to be wrong in front of a
 * customer: it answers confidently, specifically, and with last week's prices.
 */

describe('catalogue freshness warnings', () => {
  const cases: Array<[CatalogueState, RegExp]> = [
    [{ fresh: false, reason: 'connection_expired', lastSyncedAt: null }, /stopped working/i],
    [{ fresh: false, reason: 'stale', lastSyncedAt: new Date() }, /not updated in over a day/i],
    [{ fresh: false, reason: 'not_connected', lastSyncedAt: null }, /not connected/i],
    [{ fresh: false, reason: 'empty', lastSyncedAt: null }, /no products/i],
  ];

  for (const [state, expected] of cases) {
    test(`explains "${state.fresh ? 'fresh' : state.reason}" in plain words`, () => {
      const warning = catalogueWarning(state);
      assert.ok(warning);
      assert.match(warning, expected);
    });
  }

  test('says what the agent will do instead, not just that something is broken', () => {
    const warning = catalogueWarning({ fresh: false, reason: 'connection_expired', lastSyncedAt: null });
    assert.match(warning!, /pass those questions to you/i);
  });

  test('a fresh catalogue warns about nothing', () => {
    assert.equal(catalogueWarning({ fresh: true, lastSyncedAt: new Date() }), null);
  });

  test('the staleness threshold leaves room for one failed hourly sync', () => {
    // The sync runs hourly; tripping on a single missed run would cry wolf.
    assert.ok(MAX_CATALOGUE_AGE_MS >= 2 * 60 * 60 * 1000);
  });
});

describe('revival leaves threads the merchant is handling alone', () => {
  const now = new Date('2026-08-15T12:00:00.000Z');
  const twoDaysAgo = new Date(now.getTime() - 2 * 86_400_000);

  const base = {
    lastMessageAt: twoDaysAgo,
    lastInboundAt: twoDaysAgo,
    outcome: null,
    revivalSentAt: null,
    status: 'stalled',
  };

  test('a thread she answered herself is never revived', () => {
    // Otherwise the agent follows up on a conversation the owner is already
    // handling personally — over the top of her.
    const decision = decideRevival({ ...base, merchantTookOverAt: new Date() }, now);
    assert.equal(decision.eligible, false);
    assert.equal(decision.eligible === false && decision.retire, false);
  });

  test('an untouched thread is still eligible', () => {
    assert.equal(decideRevival({ ...base, merchantTookOverAt: null }, now).eligible, true);
  });
});
