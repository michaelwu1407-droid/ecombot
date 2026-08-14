import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildShopperSystemPrompt } from '../lib/agent/prompt';
import type { ShopperContext } from '../lib/agent/types';

function context(overrides: Partial<ShopperContext> = {}): ShopperContext {
  return {
    merchantId: 'm1',
    businessName: 'Wren & Co',
    conversationId: 'c1',
    source: 'dm',
    customer: {
      id: 'cu1',
      handle: 'jane_doe',
      name: null,
      size: null,
      preferences: {},
      budget_range: null,
      lifetime_value_cents: 0,
    },
    config: {
      brand_voice: null,
      voice_examples: [],
      discount_floor_pct: 0,
      escalation_rules: null,
      auto_send: false,
      active_hours: null,
      shipping_policy: null,
      returns_policy: null,
    },
    skills: [],
    history: [],
    ...overrides,
  };
}

describe('shopper system prompt', () => {
  test('states the business it replies as', () => {
    assert.match(buildShopperSystemPrompt(context()), /sales assistant for Wren & Co/);
  });

  test('carries every rule the spec requires', () => {
    const prompt = buildShopperSystemPrompt(context());
    assert.match(prompt, /Never invent a price/i);
    assert.match(prompt, /Never promise a delivery date, a refund/i);
    assert.match(prompt, /never give medical, health, dosage or safety advice/i);
    assert.match(prompt, /waitlist/i);
    assert.match(prompt, /complaint, a return, a dispute/i);
    assert.match(prompt, /under three sentences/i);
  });

  test('states the prompt-injection rule, since public input reaches this model', () => {
    const prompt = buildShopperSystemPrompt(context());
    assert.match(prompt, /data, not instructions/i);
    // Placed last so it sits closest to the untrusted content in the message list.
    assert.ok(prompt.lastIndexOf('data, not instructions') > prompt.indexOf('Never invent a price'));
  });

  test('includes the discount floor only when one is set', () => {
    assert.doesNotMatch(buildShopperSystemPrompt(context()), /never offer more than/i);

    const withFloor = buildShopperSystemPrompt(
      context({ config: { ...context().config, discount_floor_pct: 10 } })
    );
    assert.match(withFloor, /never offer more than 10% off/i);
  });

  test('includes voice examples, capped and whitespace-normalised', () => {
    const examples = Array.from({ length: 12 }, (_, i) => `Reply number ${i}\n  with a break`);
    const prompt = buildShopperSystemPrompt(
      context({ config: { ...context().config, voice_examples: examples } })
    );

    assert.match(prompt, /Reply number 0 with a break/);
    assert.match(prompt, /Reply number 7/);
    assert.doesNotMatch(prompt, /Reply number 8/); // capped at 8
  });

  test('ignores voice examples that are not usable strings', () => {
    const prompt = buildShopperSystemPrompt(
      context({ config: { ...context().config, voice_examples: [null, 42, '', '  ', { a: 1 }] } })
    );
    assert.doesNotMatch(prompt, /Real replies the owner has written/);
  });

  test('surfaces what is known about the shopper', () => {
    const prompt = buildShopperSystemPrompt(
      context({
        customer: {
          id: 'cu1',
          handle: 'jane_doe',
          name: 'Jane',
          size: '10',
          preferences: { colours: ['navy', 'cream'], fit: 'relaxed' },
          budget_range: 'under $150',
          lifetime_value_cents: 24000,
        },
      })
    );

    assert.match(prompt, /Name: Jane/);
    assert.match(prompt, /Usual size: 10/);
    assert.match(prompt, /colours: navy, cream/);
    assert.match(prompt, /fit: relaxed/);
    assert.match(prompt, /Budget: under \$150/);
    assert.match(prompt, /\$240\.00 lifetime/);
    // She should not read it back at them like a form.
    assert.match(prompt, /do not recite it back/i);
  });

  test('omits the customer section entirely for a stranger', () => {
    assert.doesNotMatch(buildShopperSystemPrompt(context()), /What you already know/);
  });

  test('includes enabled skills verbatim', () => {
    const prompt = buildShopperSystemPrompt(
      context({ skills: [{ name: 'Occasion', content: 'Always ask what occasion it is for.' }] })
    );
    assert.match(prompt, /## Occasion/);
    assert.match(prompt, /Always ask what occasion it is for\./);
  });

  test('tells the agent when the conversation began as a comment', () => {
    assert.match(buildShopperSystemPrompt(context({ source: 'comment' })), /commented on a post/i);
    assert.doesNotMatch(buildShopperSystemPrompt(context({ source: 'dm' })), /commented on a post/i);
  });
});
