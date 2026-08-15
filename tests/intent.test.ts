import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyComment,
  classifyCommentHeuristic,
  stageOneDiscards,
  stageTwoAccepts,
  EXPLORATION_RATE,
} from '../lib/capture/intent';
import { isOptOut } from '../lib/inbound';
import { hashText, humanisedDelayMs, LIMITS } from '../lib/limits';

/**
 * The filter now optimises **recall**, reversing the earlier precision bias. A false
 * positive is a friendly DM to a browser; a false negative is a lost sale.
 */

describe('stage 1 — rules discard what cannot be a lead', () => {
  for (const text of ['😍', '😍😍😍', '🔥', '@sarah', '@sarah @jess', '!!', '  ', 'x']) {
    test(`discards ${JSON.stringify(text)}`, () => {
      assert.equal(stageOneDiscards(text), true);
    });
  }

  test('keeps anything with actual words in it', () => {
    assert.equal(stageOneDiscards('love this'), false);
    assert.equal(stageOneDiscards('@sarah look at this'), false);
  });
});

describe('stage 2 — obvious buying language, no model call', () => {
  const buying = [
    'how much?',
    'price?',
    'link',
    'is this still available?',
    'do you have this in a 10?',
    'do you ship to Australia?',
    'what sizes does this come in?',
    'does it come in cream',
    'can i buy this',
    'where can i get this',
    'restock please',
    "i'll take one",
    'need this',
    'want this',
    'sold out?',
  ];

  for (const text of buying) {
    test(`passes: ${text}`, () => assert.equal(stageTwoAccepts(text), true));
  }

  test('a compliment wrapped around a question still passes', () => {
    assert.equal(stageTwoAccepts('obsessed 😍 how much?'), true);
  });
});

describe('stage 3 — the ambiguous middle reaches the model', () => {
  test('praise with no question is no longer discarded outright', () => {
    // The old build treated all of these as noise. Under recall bias they are
    // judgement calls, and judgement calls go to the classifier.
    assert.equal(classifyCommentHeuristic('love this'), 'unclear');
    assert.equal(classifyCommentHeuristic('need this in my life'), 'buying');
    assert.equal(classifyCommentHeuristic('this would be perfect for the wedding'), 'unclear');
  });

  test('the rules and patterns still settle the clear cases without a model call', () => {
    // The whole point of three stages: a 200-comment post costs a handful of
    // calls, not 200.
    assert.notEqual(classifyCommentHeuristic('how much?'), 'unclear');
    assert.notEqual(classifyCommentHeuristic('😍'), 'unclear');
  });
});

describe('exploration sampling — the part that cannot be backfilled', () => {
  const realFetch = globalThis.fetch;

  /** The classifier says NO; the sampling is what decides whether we reply anyway. */
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    process.env.OPENROUTER_MODEL = 'anthropic/claude-sonnet-4';
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'NO' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('a turned-down comment is answered anyway at the sample rate', async () => {
    // Without this, a future classifier only ever sees outcomes for comments we
    // already believed in, and narrows until it catches nothing but the obvious.
    const decision = await classifyComment('hmm interesting', () => 0.01);
    assert.equal(decision.exploration, true);
    assert.equal(decision.intent, 'buying');
  });

  test('most turned-down comments stay turned down', async () => {
    const decision = await classifyComment('hmm interesting', () => 0.9);
    assert.equal(decision.exploration, false);
  });

  test('the sample rate is small enough not to be a broadcast', () => {
    assert.ok(EXPLORATION_RATE > 0 && EXPLORATION_RATE <= 0.1);
  });

  test('an unreachable model never turns into an unsolicited DM', async () => {
    // Recall bias is a judgement call, not a licence to message people during an
    // outage. Exploration data is lost; the merchant's account is not.
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;

    const decision = await classifyComment('hmm interesting', () => 0.001);
    assert.equal(decision.intent, 'noise');
    assert.equal(decision.exploration, false);
  });

  test('stages 1 and 2 are never sampled — there is nothing uncertain to learn', async () => {
    assert.equal((await classifyComment('😍', () => 0.001)).exploration, false);
    assert.equal((await classifyComment('how much?', () => 0.001)).exploration, false);
  });

  test('records which stage decided, for the training set', async () => {
    assert.equal((await classifyComment('😍')).stage, 1);
    assert.equal((await classifyComment('how much?')).stage, 2);
  });
});

describe('opt-out', () => {
  for (const text of [
    'stop messaging me',
    'please stop contacting me',
    "don't message me again",
    'unsubscribe',
    'leave me alone',
    'take me off your list',
    'remove me from your waitlist',
  ]) {
    test(`honours: ${text}`, () => assert.equal(isOptOut(text), true));
  }

  test('does not fire on ordinary conversation', () => {
    // Treating "stop it 😂" as an opt-out would silently lose a customer.
    assert.equal(isOptOut('stop it 😂 that dress is unreal'), false);
    assert.equal(isOptOut('I need to stop spending money here'), false);
    assert.equal(isOptOut('can you stop the order?'), false);
  });
});

describe('rate discipline — what holds the line now that precision does not', () => {
  test('comment replies have their own daily ceiling', () => {
    // A drop-day post with 200 comments must not become 200 unsolicited DMs.
    assert.ok(LIMITS.privateRepliesPerMerchantPerDay > 0);
    assert.ok(LIMITS.privateRepliesPerMerchantPerDay < 200);
  });

  test('identical text hashes identically, through trivial edits', () => {
    assert.equal(hashText('Still available!'), hashText('still available'));
    assert.equal(hashText('Yes  — still  available'), hashText('yes still available'));
  });

  test('different messages hash differently', () => {
    assert.notEqual(hashText('still available'), hashText('sold out sorry'));
  });

  test('the send delay is randomised and human-scaled', () => {
    const delays = new Set(Array.from({ length: 20 }, () => humanisedDelayMs()));
    assert.ok(delays.size > 1, 'a fixed delay is its own automation signal');

    for (const delay of delays) {
      assert.ok(delay >= 4_000 && delay <= 15_000, `${delay}ms out of range`);
    }
  });
});
