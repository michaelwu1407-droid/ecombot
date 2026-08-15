import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { selectVoiceExamples } from '../lib/onboarding';
import { allowWebhook, resetWebhookLimits } from '../lib/webhook-rate-limit';

describe('voice example selection', () => {
  test('keeps replies that show how she writes', () => {
    const examples = selectVoiceExamples([
      'yes we do! it comes in a 10, want me to put one aside for you?',
      'hey lovely, that one sold out but more land friday x',
    ]);
    assert.equal(examples.length, 2);
  });

  test('drops one-word replies, which teach nothing', () => {
    assert.deepEqual(selectVoiceExamples(['yes', 'ok', 'thanks!', 'sure']), []);
  });

  test('drops essays, which are not how she usually writes', () => {
    assert.deepEqual(selectVoiceExamples(['a'.repeat(500)]), []);
  });

  test('drops anything with a link, which reads as automated', () => {
    assert.deepEqual(
      selectVoiceExamples(['here you go https://shop.example.com/products/linen-dress love']),
      []
    );
  });

  test('collapses near-duplicates', () => {
    // Someone who types "still available!" forty times should not get forty
    // examples of it.
    const examples = selectVoiceExamples([
      'yes still available lovely, want me to hold it?',
      'Yes, still available lovely — want me to hold it?',
      'hey! that one is sold out sorry, more coming friday',
    ]);
    assert.equal(examples.length, 2);
  });

  test('normalises whitespace', () => {
    const [example] = selectVoiceExamples(['yes  we\n  have  it in a 10, want one put aside?']);
    assert.equal(example, 'yes we have it in a 10, want one put aside?');
  });

  test('caps how many are kept', () => {
    const many = Array.from({ length: 100 }, (_, i) => `reply number ${i} with enough words to count`);
    assert.equal(selectVoiceExamples(many).length, 30);
  });
});

describe('webhook rate limiting', () => {
  test('allows a normal burst', () => {
    resetWebhookLimits();
    for (let i = 0; i < 100; i += 1) {
      assert.equal(allowWebhook('acct_1'), true, `request ${i} should be allowed`);
    }
  });

  test('sheds load once the bucket empties', () => {
    resetWebhookLimits();
    const now = Date.now();
    for (let i = 0; i < 120; i += 1) allowWebhook('acct_1', now);
    assert.equal(allowWebhook('acct_1', now), false);
  });

  test('refills over time', () => {
    resetWebhookLimits();
    const now = Date.now();
    for (let i = 0; i < 120; i += 1) allowWebhook('acct_1', now);

    assert.equal(allowWebhook('acct_1', now), false);
    // Four tokens a second, so a second later there is room again.
    assert.equal(allowWebhook('acct_1', now + 1000), true);
  });

  test('one noisy account does not shut out another merchant', () => {
    resetWebhookLimits();
    const now = Date.now();
    for (let i = 0; i < 200; i += 1) allowWebhook('acct_noisy', now);

    assert.equal(allowWebhook('acct_noisy', now), false);
    assert.equal(allowWebhook('acct_quiet', now), true);
  });
});
