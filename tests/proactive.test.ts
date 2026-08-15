import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideRevival,
  MIN_STALL_MS,
  MAX_STALL_MS,
  type RevivalCandidate,
} from '../lib/proactive/eligibility';
import { LIMITS } from '../lib/limits';

const now = new Date('2026-08-15T12:00:00.000Z');

function candidate(overrides: Partial<RevivalCandidate> = {}): RevivalCandidate {
  const twoDaysAgo = new Date(now.getTime() - 2 * 86_400_000);
  return {
    lastMessageAt: twoDaysAgo,
    lastInboundAt: twoDaysAgo,
    outcome: null,
    revivalSentAt: null,
    status: 'stalled',
    ...overrides,
  };
}

describe('dead thread revival — who gets followed up', () => {
  test('a thread quiet for two days is worth one nudge', () => {
    const decision = decideRevival(candidate(), now);
    assert.equal(decision.eligible, true);
    // Past 24 hours, so Instagram needs the merchant to approve it.
    assert.equal(decision.eligible && decision.requiresApproval, true);
  });

  test('a thread quiet for 25 hours goes out without approval only inside the window', () => {
    const justOver = new Date(now.getTime() - MIN_STALL_MS - 3_600_000);
    const decision = decideRevival(
      candidate({ lastMessageAt: justOver, lastInboundAt: justOver }),
      now
    );
    assert.equal(decision.eligible, true);
    assert.equal(decision.eligible && decision.requiresApproval, true);
  });

  test('an agent message can restart the clock while the customer stays inside the window', () => {
    // Quiet since our own last message two days ago, but the customer wrote
    // twelve hours ago — still freely reachable.
    const decision = decideRevival(
      candidate({
        lastMessageAt: new Date(now.getTime() - 2 * 86_400_000),
        lastInboundAt: new Date(now.getTime() - 12 * 3_600_000),
      }),
      now
    );
    assert.equal(decision.eligible, true);
    assert.equal(decision.eligible && decision.requiresApproval, false);
  });
});

describe('dead thread revival — who is left alone', () => {
  test('a thread that is still warm', () => {
    const decision = decideRevival(
      candidate({ lastMessageAt: new Date(now.getTime() - 3_600_000) }),
      now
    );
    assert.equal(decision.eligible, false);
    assert.equal(decision.eligible === false && decision.retire, false);
  });

  test('a thread that already ended in a sale', () => {
    const decision = decideRevival(candidate({ outcome: 'sale' }), now);
    assert.equal(decision.eligible, false);
    assert.equal(decision.eligible === false && decision.retire, true);
  });

  test('a thread already revived once — a second is nagging', () => {
    const decision = decideRevival(candidate({ revivalSentAt: new Date() }), now);
    assert.equal(decision.eligible, false);
  });

  test('a thread the merchant is handling', () => {
    const decision = decideRevival(candidate({ status: 'escalated' }), now);
    assert.equal(decision.eligible, false);
    // Not retired: if they resolve it, it could become eligible again.
    assert.equal(decision.eligible === false && decision.retire, false);
  });

  test('a closed thread', () => {
    const decision = decideRevival(candidate({ status: 'closed' }), now);
    assert.equal(decision.eligible, false);
    assert.equal(decision.eligible === false && decision.retire, true);
  });

  test('a thread past the 7-day window is retired, not retried forever', () => {
    const old = new Date(now.getTime() - MAX_STALL_MS - 86_400_000);
    const decision = decideRevival(candidate({ lastMessageAt: old, lastInboundAt: old }), now);

    assert.equal(decision.eligible, false);
    assert.equal(decision.eligible === false && decision.reason, 'messaging window closed');
    // Otherwise the sweep reconsiders it every four hours, forever.
    assert.equal(decision.eligible === false && decision.retire, true);
  });

  test('a conversation the customer never wrote in cannot be messaged', () => {
    const decision = decideRevival(candidate({ lastInboundAt: null }), now);
    assert.equal(decision.eligible, false);
    assert.equal(decision.eligible === false && decision.reason, 'messaging window closed');
  });

  test('a conversation with no activity at all', () => {
    const decision = decideRevival(candidate({ lastMessageAt: null }), now);
    assert.equal(decision.eligible, false);
  });
});

describe('rate limits', () => {
  test('proactive limits are tighter than reactive ones', () => {
    // Someone messaging the shop expects an answer. Someone who did not message
    // is where account standing gets spent.
    assert.ok(LIMITS.proactivePerMerchantPerDay < LIMITS.repliesPerMerchantPerHour);
  });

  test('a customer gets at most one unprompted message a week', () => {
    assert.equal(LIMITS.proactivePerCustomerPerWeek, 1);
  });

  test('a conversation gets at most one revival', () => {
    assert.equal(LIMITS.revivalsPerConversation, 1);
  });
});
