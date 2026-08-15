import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  proposalQuestion,
  PROPOSAL_THRESHOLD,
  REJECTION_COOLDOWN_MS,
  type PendingProposal,
} from '../lib/learning';

/**
 * The self-learning loop is the moat (§4.12), and its entire interface is one
 * sentence and two buttons. If that sentence is not readable and specific, she
 * stops reading them, and then the loop is worth nothing.
 */

function proposal(overrides: Partial<PendingProposal> = {}): PendingProposal {
  return {
    id: 'p1',
    questionType: 'sizing',
    proposedContent: 'Always mention that the fit runs small on dresses.',
    correctionCount: 4,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('the question she is asked', () => {
  test('says what she did, how often, and what would change', () => {
    const question = proposalQuestion(proposal());

    assert.match(question, /changed how I answer sizing questions/);
    assert.match(question, /4 times/);
    assert.match(question, /fit runs small/);
  });

  test('names the subject in her words, not ours', () => {
    // "policy" is our column value; "your policies" is what a person says.
    assert.match(
      proposalQuestion(proposal({ questionType: 'policy' })),
      /questions about your policies/
    );
    assert.match(proposalQuestion(proposal({ questionType: 'shipping' })), /shipping questions/);
  });

  test('degrades to something readable for an unclustered pattern', () => {
    const question = proposalQuestion(proposal({ questionType: 'other' }));
    assert.match(question, /some replies/);
    assert.doesNotMatch(question, /other/);
  });

  test('stays one sentence long enough to read on a phone', () => {
    // She reads this between customers. Two buttons, one sentence.
    assert.ok(proposalQuestion(proposal()).length < 200);
  });
});

describe('when it asks at all', () => {
  test('waits for a pattern, not a one-off', () => {
    // One edit is a correction; three is a rule. Proposing after one would train
    // her to ignore the prompts.
    assert.equal(PROPOSAL_THRESHOLD, 3);
  });

  test('a rejected pattern is left alone for a month', () => {
    // Being asked the same question every week is its own kind of failure.
    assert.equal(REJECTION_COOLDOWN_MS, 30 * 24 * 60 * 60 * 1000);
  });
});
