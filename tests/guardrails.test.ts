import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { runGuardrails, extractMoneyCents, MAX_REPLY_LENGTH } from '../lib/agent/guardrails';
import { emptyLedger } from '../lib/agent/types';
import type { AgentConfig, TurnLedger } from '../lib/agent/types';

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    brand_voice: null,
    voice_examples: [],
    discount_floor_pct: 0,
    escalation_rules: null,
    auto_send: true,
    active_hours: null,
    shipping_policy: null,
    returns_policy: null,
    ...overrides,
  };
}

function ledger(setup: (l: TurnLedger) => void = () => {}): TurnLedger {
  const l = emptyLedger();
  setup(l);
  return l;
}

function verdict(text: string, l = ledger(), c = config()) {
  return runGuardrails({ text, ledger: l, config: c });
}

// ---------------------------------------------------------------------------

describe('1. price check', () => {
  test('allows a price a tool returned', () => {
    const l = ledger((x) => x.pricesCents.add(4500));
    assert.equal(verdict('The linen dress is $45.', l).action, 'pass');
  });

  test('blocks a price no tool returned — the failure this exists to catch', () => {
    const l = ledger((x) => x.pricesCents.add(4500));
    const result = verdict('The linen dress is $39.', l);
    assert.equal(result.action, 'block');
    assert.equal(result.action === 'block' && result.guardrail, 'price_check');
  });

  test('blocks any price when no tool was called at all', () => {
    assert.equal(verdict("It's $45.").action, 'block');
  });

  test('passes a reply with no prices in it', () => {
    assert.equal(verdict('Yes, that comes in navy and cream.').action, 'pass');
  });

  test('matches formatting variations of the same figure', () => {
    const l = ledger((x) => x.pricesCents.add(4500));
    assert.equal(verdict('$45', l).action, 'pass');
    assert.equal(verdict('$45.00', l).action, 'pass');
    assert.equal(verdict('$ 45', l).action, 'pass');
    assert.equal(verdict('45 dollars', l).action, 'pass');
  });

  test('handles thousands separators', () => {
    const l = ledger((x) => x.pricesCents.add(129995));
    assert.equal(verdict('The coat is $1,299.95.', l).action, 'pass');
    assert.equal(verdict('The coat is $1,199.95.', l).action, 'block');
  });

  test('allows a bundle total, so quoting two items together still works', () => {
    const l = ledger((x) => {
      x.pricesCents.add(4500);
      x.pricesCents.add(3000);
    });
    assert.equal(verdict('Both together would be $75.', l).action, 'pass');
  });

  test('blocks a total that is not a sum of anything looked up', () => {
    const l = ledger((x) => {
      x.pricesCents.add(4500);
      x.pricesCents.add(3000);
    });
    assert.equal(verdict('Both together would be $70.', l).action, 'block');
  });

  test('blocks a discounted price when discounts are off', () => {
    const l = ledger((x) => x.pricesCents.add(4500));
    assert.equal(verdict('I can do $40 for you.', l).action, 'block');
  });

  test('allows a discount inside the floor, and blocks one past it', () => {
    const l = ledger((x) => x.pricesCents.add(10000));
    const c = config({ discount_floor_pct: 10 });

    assert.equal(verdict('I can do $95 for you.', l, c).action, 'pass');
    assert.equal(verdict('I can do $90 for you.', l, c).action, 'pass');
    assert.equal(verdict('I can do $85 for you.', l, c).action, 'block');
  });

  test('checks every figure, not just the first', () => {
    const l = ledger((x) => x.pricesCents.add(4500));
    assert.equal(verdict('The dress is $45 and the belt is $20.', l).action, 'block');
  });

  test('treats other currencies as money too', () => {
    const l = ledger((x) => x.pricesCents.add(4500));
    assert.equal(verdict('The dress is £45.', l).action, 'pass');
    assert.equal(verdict('The dress is €39.', l).action, 'block');
  });
});

describe('money extraction', () => {
  test('does not treat sizes or counts as prices', () => {
    // Otherwise almost every legitimate reply would be blocked.
    assert.deepEqual(extractMoneyCents('We have it in a size 10, 2 left.'), []);
    assert.deepEqual(extractMoneyCents('Delivery is 3-5 days.'), []);
  });

  test('finds symbol and word forms', () => {
    assert.deepEqual(extractMoneyCents('$45'), [4500]);
    assert.deepEqual(extractMoneyCents('45 dollars'), [4500]);
    assert.deepEqual(extractMoneyCents('£12.50'), [1250]);
  });

  test('rounds rather than truncating', () => {
    assert.deepEqual(extractMoneyCents('$19.99'), [1999]);
  });
});

describe('2. discount floor', () => {
  test('blocks a discount past the floor', () => {
    const result = verdict('I can do 20% off.', ledger(), config({ discount_floor_pct: 10 }));
    assert.equal(result.action, 'block');
    assert.equal(result.action === 'block' && result.guardrail, 'discount_floor');
  });

  test('allows a discount at or inside the floor', () => {
    const c = config({ discount_floor_pct: 10 });
    assert.equal(verdict('I can do 10% off.', ledger(), c).action, 'pass');
    assert.equal(verdict('I can do 5% off.', ledger(), c).action, 'pass');
  });

  test('blocks any discount when the floor is zero', () => {
    assert.equal(verdict('I can do 5% off for you.').action, 'block');
  });

  test('does not mistake a product description for an offer', () => {
    // "95% cotton" is not a discount, and blocking it would be maddening.
    assert.equal(verdict('It is 95% cotton and 5% elastane.').action, 'pass');
    assert.equal(verdict('The fabric is 100% linen.').action, 'pass');
  });

  test('catches the phrasing reversed', () => {
    const c = config({ discount_floor_pct: 10 });
    assert.equal(verdict('I can take 25 percent off the sale price.', ledger(), c).action, 'block');
  });
});

describe('3. stock claims', () => {
  test('blocks an availability claim with no confirming stock check', () => {
    const result = verdict('Yes, we have it in stock!');
    assert.equal(result.action, 'block');
    assert.equal(result.action === 'block' && result.guardrail, 'stock_claim');
  });

  test('allows it when a tool confirmed the variant', () => {
    const l = ledger((x) => x.availableVariantIds.add('v1'));
    assert.equal(verdict('Yes, we have it in stock!', l).action, 'pass');
  });

  test('blocks when the only lookup came back unavailable', () => {
    const l = ledger((x) => x.unavailableVariantIds.add('v1'));
    assert.equal(verdict("Yes, we've got some left.", l).action, 'block');
  });

  test('does not fire on a reply that claims nothing', () => {
    assert.equal(verdict('Let me check that for you.').action, 'pass');
  });

  test('allows saying an item is sold out without a stock check', () => {
    // Being cautious in the shopper's favour never needs blocking.
    assert.equal(verdict("Sorry, that one's sold out — want me to add you to the waitlist?").action, 'pass');
  });
});

describe('4. prohibited claims', () => {
  test('blocks a claim that a product treats a condition', () => {
    for (const text of [
      'This cream treats eczema.',
      'It cures acne within a week.',
      'This heals damaged skin.',
      'It prevents wrinkles.',
      'Clinically proven to reduce inflammation.',
    ]) {
      const result = verdict(text);
      assert.equal(result.action, 'block', `should block: ${text}`);
      assert.equal(result.action === 'block' && result.guardrail, 'prohibited_claims');
    }
  });

  test('blocks health and safety advice', () => {
    assert.equal(verdict('It is safe for pregnancy.').action, 'block');
    assert.equal(verdict("It won't irritate your skin.").action, 'block');
    assert.equal(verdict('This is allergy-free.').action, 'block');
  });

  test('blocks the softer version — a condition plus reassurance', () => {
    assert.equal(verdict('It is great for acne-prone skin.').action, 'block');
    assert.equal(verdict('Lots of customers with eczema find it helps.').action, 'block');
  });

  test('does not block ordinary product talk', () => {
    const l = ledger((x) => x.availableVariantIds.add('v1'));
    assert.equal(verdict('It is a soft cotton blend, in stock in navy.', l).action, 'pass');
    assert.equal(verdict('This one is unscented if you prefer that.').action, 'pass');
  });
});

describe('5. unfounded promises', () => {
  test('blocks a delivery date with no shipping policy in play', () => {
    const result = verdict('It will arrive by Tuesday.');
    assert.equal(result.action, 'block');
    assert.equal(result.action === 'block' && result.guardrail, 'unfounded_promise');

    assert.equal(verdict('It should be delivered within 3 days.').action, 'block');
    assert.equal(verdict('We ship it and it gets to you tomorrow.').action, 'block');
  });

  test('allows a delivery answer once the policy was actually read', () => {
    const l = ledger((x) => x.policies.set('shipping', 'Orders ship next business day, arriving in 2-4 days.'));
    assert.equal(verdict('It should arrive within 4 days.', l).action, 'pass');
  });

  test('blocks a refund promise with no returns policy in play', () => {
    assert.equal(verdict("We'll refund you straight away.").action, 'block');
    assert.equal(verdict('Full refund, no questions asked.').action, 'block');
  });

  test('allows a refund answer once the policy was read', () => {
    const l = ledger((x) => x.policies.set('returns', 'Full refund within 30 days, unworn.'));
    assert.equal(verdict('We can refund you within 30 days if it is unworn.', l).action, 'pass');
  });

  test('blocks a policy exception even when the policy was read', () => {
    const l = ledger((x) => x.policies.set('returns', 'Returns within 30 days.'));
    // An exception is by definition not in the policy.
    assert.equal(verdict("I'll make an exception just this once.", l).action, 'block');
  });
});

describe('6. uncertainty', () => {
  test('blocks hedging on a refund or complaint', () => {
    const result = verdict('I think you should be able to get a refund.');
    assert.equal(result.action, 'block');
    assert.equal(result.action === 'block' && result.guardrail, 'uncertainty');

    assert.equal(verdict("I'm not sure about our returns policy.").action, 'block');
    assert.equal(verdict('That reaction is probably nothing to worry about.').action, 'block');
  });

  test('allows hedging about something harmless', () => {
    assert.equal(verdict('I think the navy suits you better.').action, 'pass');
    assert.equal(verdict('It might be a little loose on the arms.').action, 'pass');
  });

  test('allows a confident answer on a sensitive topic', () => {
    const l = ledger((x) => x.policies.set('returns', 'Returns within 30 days.'));
    assert.equal(verdict('Returns are within 30 days.', l).action, 'pass');
  });
});

describe('7. length', () => {
  test('asks for a rewrite the first time', () => {
    const result = verdict('a'.repeat(MAX_REPLY_LENGTH + 1));
    assert.equal(result.action, 'retry_shorter');
  });

  test('blocks if it is still too long on the retry', () => {
    const result = runGuardrails({
      text: 'a'.repeat(MAX_REPLY_LENGTH + 1),
      ledger: ledger(),
      config: config(),
      isRetry: true,
    });
    assert.equal(result.action, 'block');
    assert.equal(result.action === 'block' && result.guardrail, 'length');
  });

  test('allows a reply exactly at the limit', () => {
    assert.equal(verdict('a'.repeat(MAX_REPLY_LENGTH)).action, 'pass');
  });
});

describe('ordering and combinations', () => {
  test('a factual problem is reported ahead of a stylistic one', () => {
    // Long *and* wrong should read as wrong.
    const result = verdict(`This cream cures eczema. ${'a'.repeat(MAX_REPLY_LENGTH)}`);
    assert.equal(result.action, 'block');
    assert.equal(result.action === 'block' && result.guardrail, 'prohibited_claims');
  });

  test('a clean, grounded reply passes everything', () => {
    const l = ledger((x) => {
      x.pricesCents.add(4500);
      x.availableVariantIds.add('v1');
      x.policies.set('shipping', 'Ships next business day.');
    });
    assert.equal(
      verdict("Yes, we have it in a 10 — it's $45 and ships next business day.", l).action,
      'pass'
    );
  });

  test('an empty reply is not blocked by anything', () => {
    assert.equal(verdict('').action, 'pass');
  });
});
