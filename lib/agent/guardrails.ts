import type { AgentConfig, TurnLedger } from './types';

/**
 * The eight guardrails (BUILD_SPEC §4.4), run on every outbound message.
 *
 * These are in code, not in the prompt, and that is the whole point (§3.3). Models
 * are probabilistic, and this runs on the merchant's own business account. A prompt
 * instruction not to invent prices will eventually be violated; a code check that
 * rejects any dollar figure not returned by a tool will not.
 *
 * Trust is asymmetric (§1.4): a hundred good conversations do not offset one bad
 * one. So every check here fails closed — when in doubt, the merchant handles it.
 *
 * Pure functions with no I/O, so they are exhaustively testable and cannot be
 * skipped by a caller that forgets to await something.
 */

export const MAX_REPLY_LENGTH = 500;

export type GuardrailVerdict =
  /** Send it. */
  | { action: 'pass' }
  /** Too long. The loop retries once with a brevity instruction. */
  | { action: 'retry_shorter'; reason: string }
  /** Never send. Queue for the merchant with the reason attached. */
  | { action: 'block'; guardrail: string; reason: string };

export interface GuardrailInput {
  text: string;
  ledger: TurnLedger;
  config: AgentConfig;
  /** True on the second pass, so the length check blocks instead of retrying. */
  isRetry?: boolean;
}

export function runGuardrails(input: GuardrailInput): GuardrailVerdict {
  // Order matters only for which reason the merchant sees first. Correctness
  // checks come before style ones.
  const checks = [
    checkProhibitedClaims,
    checkPrices,
    checkDiscountFloor,
    checkStockClaims,
    checkUnfoundedPromises,
    checkUncertainty,
    checkLength,
  ];

  for (const check of checks) {
    const verdict = check(input);
    if (verdict.action !== 'pass') return verdict;
  }

  return { action: 'pass' };
}

// ---------------------------------------------------------------------------
// 1. Price check
// ---------------------------------------------------------------------------

/**
 * Every money figure in the reply must trace to a tool result from this turn.
 *
 * Exact tool prices are obviously fine. Two derivations are also allowed, because
 * without them the agent cannot do things §2.2 explicitly asks for:
 *
 *   * **Sums of tool prices**, so it can quote a bundle ("both for $90").
 *   * **Discounts within the configured floor**, so it can negotiate at all.
 *
 * Everything else is blocked. A number the model produced from nowhere is the
 * exact failure this guardrail exists to catch.
 */
function checkPrices(input: GuardrailInput): GuardrailVerdict {
  const quoted = extractMoneyCents(input.text);
  if (!quoted.length) return { action: 'pass' };

  const allowed = allowedPriceSet(input.ledger.pricesCents, input.config.discount_floor_pct);

  for (const cents of quoted) {
    if (!allowed.permits(cents)) {
      return {
        action: 'block',
        guardrail: 'price_check',
        reason: `The reply quoted ${formatCents(cents)}, which no product lookup returned this turn.`,
      };
    }
  }

  return { action: 'pass' };
}

interface AllowedPrices {
  permits(cents: number): boolean;
}

function allowedPriceSet(prices: Set<number>, discountFloorPct: number): AllowedPrices {
  const exact = new Set(prices);

  // Subset sums, so a bundle of things the agent actually looked up can be quoted.
  // Bounded at 4 items and 12 source prices — beyond that the combinations stop
  // being a bundle and start being a way to justify any number at all.
  const base = [...prices].slice(0, 12);
  const sums = new Set<number>(base);
  for (let size = 2; size <= Math.min(4, base.length); size += 1) {
    for (const combination of combinations(base, size)) {
      sums.add(combination.reduce((total, price) => total + price, 0));
    }
  }
  for (const sum of sums) exact.add(sum);

  const floor = Math.max(0, Math.min(100, discountFloorPct));

  return {
    permits(cents: number): boolean {
      if (exact.has(cents)) return true;
      if (floor === 0) return false;

      // A discounted figure must sit between the floor price and the list price.
      // Rounding to the nearest cent is allowed either way.
      for (const price of exact) {
        const lowest = Math.floor(price * (1 - floor / 100));
        if (cents >= lowest - 1 && cents <= price) return true;
      }
      return false;
    },
  };
}

function* combinations(values: number[], size: number): Generator<number[]> {
  if (size === 0) {
    yield [];
    return;
  }
  for (let i = 0; i <= values.length - size; i += 1) {
    for (const rest of combinations(values.slice(i + 1), size - 1)) {
      yield [values[i], ...rest];
    }
  }
}

const MONEY_SYMBOL = /(?:[$£€])\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g;
const MONEY_WORD = /(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*(?:dollars|pounds|euros|bucks|usd|aud|nzd|cad|gbp|eur)\b/gi;

/**
 * Money figures only — a bare number is not one.
 *
 * "a size 10", "2 left", "3-5 days" are all bare numbers, and treating them as
 * prices would block almost every legitimate reply. The cost of that choice is
 * that "it's 45" slips through unchecked; the prompt asks for a currency symbol,
 * and quoting a naked number is not a natural way to answer a price question.
 */
export function extractMoneyCents(text: string): number[] {
  const found: number[] = [];

  for (const pattern of [MONEY_SYMBOL, MONEY_WORD]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const amount = Number.parseFloat(match[1].replace(/,/g, ''));
      if (Number.isFinite(amount)) found.push(Math.round(amount * 100));
    }
  }

  return found;
}

// ---------------------------------------------------------------------------
// 2. Discount floor
// ---------------------------------------------------------------------------

const PERCENT_OFF =
  /(\d{1,3}(?:\.\d+)?)\s*(?:%|percent|per cent)\s*(?:off|discount|reduction)?|(?:off|discount(?:ed)? by)\s*(\d{1,3}(?:\.\d+)?)\s*(?:%|percent)/gi;

function checkDiscountFloor(input: GuardrailInput): GuardrailVerdict {
  const floor = input.config.discount_floor_pct;

  PERCENT_OFF.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = PERCENT_OFF.exec(input.text)) !== null) {
    const raw = match[1] ?? match[2];
    const percent = Number.parseFloat(raw);
    if (!Number.isFinite(percent)) continue;

    // Only percentages framed as a discount count. "95% cotton" is not an offer,
    // and the surrounding words are what tell them apart.
    if (!looksLikeDiscount(input.text, match.index)) continue;

    if (percent > floor) {
      return {
        action: 'block',
        guardrail: 'discount_floor',
        reason:
          floor === 0
            ? `The reply offered ${percent}% off, but discounts are not enabled for this shop.`
            : `The reply offered ${percent}% off, past the ${floor}% limit you set.`,
      };
    }
  }

  return { action: 'pass' };
}

function looksLikeDiscount(text: string, index: number): boolean {
  const window = text.slice(Math.max(0, index - 40), index + 60).toLowerCase();
  return /\b(off|discount|deal|reduc|sale|take|knock|special|voucher|code)\b/.test(window);
}

// ---------------------------------------------------------------------------
// 3. Stock claims
// ---------------------------------------------------------------------------

const ASSERTS_AVAILABLE =
  /\b(?:in stock|we have (?:it|them|that|those|one|a few|some)|still (?:have|available)|it'?s available|they'?re available|yes,? we do have|we do have|got (?:it|them|some) (?:in|left)|available in|there are \d+ left|we'?ve got)\b/i;

function checkStockClaims(input: GuardrailInput): GuardrailVerdict {
  if (!ASSERTS_AVAILABLE.test(input.text)) return { action: 'pass' };

  if (input.ledger.availableVariantIds.size === 0) {
    return {
      action: 'block',
      guardrail: 'stock_claim',
      reason: 'The reply said an item was available, but no stock check confirmed it this turn.',
    };
  }

  return { action: 'pass' };
}

// ---------------------------------------------------------------------------
// 4. Prohibited claims
// ---------------------------------------------------------------------------

const MEDICAL_CLAIM =
  /\b(?:cures?|curing|heals?|healing|treats?|treating|prevents?|preventing|reverses?|reduces? (?:acne|eczema|psoriasis|rosacea|wrinkles|inflammation)|clinically proven|dermatologist[- ]proven|medical(?:ly)? (?:proven|grade)|therapeutic|remedy|remedies)\b/i;

// The `\w*` after each stem matters: a trailing \b directly after "pregnan"
// would never match "pregnancy", because the next character is still a word
// character. Stems need to consume the rest of their word.
const HEALTH_ADVICE =
  /\b(?:safe (?:for|during|to (?:use|take)) (?:pregnan|breastfeed|children|babies|infants)\w*|hypoallergenic and safe|you should (?:take|apply|use) \d|dosage|dose of|won'?t (?:irritate|cause a reaction)|will not (?:irritate|cause a reaction)|allergy[- ]free|allergen[- ]free|non[- ]allergenic)\b/i;

const CONDITION_WORD =
  /\b(?:acne|eczema|psoriasis|rosacea|dermatitis|allergy|allergies|allergic|rash|infection|asthma|migraine|anxiety|depression|arthritis|diabet)/i;

/**
 * Regulatory, not stylistic. A boutique selling skincare or supplements cannot say
 * a product treats a condition, and neither can anything replying as that boutique.
 * The rule catches both the claim itself and health advice around a named condition.
 */
function checkProhibitedClaims(input: GuardrailInput): GuardrailVerdict {
  if (MEDICAL_CLAIM.test(input.text)) {
    return {
      action: 'block',
      guardrail: 'prohibited_claims',
      reason: 'The reply claimed a product treats or improves a condition. That is not allowed by law.',
    };
  }

  if (HEALTH_ADVICE.test(input.text)) {
    return {
      action: 'block',
      guardrail: 'prohibited_claims',
      reason: 'The reply gave health or safety advice. Needs a person.',
    };
  }

  // A named condition plus any reassurance is the same claim in softer words.
  if (CONDITION_WORD.test(input.text) && /\b(?:help|helps|good for|works? for|fine for|great for|perfect for)\b/i.test(input.text)) {
    return {
      action: 'block',
      guardrail: 'prohibited_claims',
      reason: 'The reply linked a product to a skin or health condition. Needs a person.',
    };
  }

  return { action: 'pass' };
}

// ---------------------------------------------------------------------------
// 5. Unfounded promises
// ---------------------------------------------------------------------------

const DELIVERY_VERB =
  String.raw`(?:arrives?|delivered?|delivery|gets? to you|be there|with you|dispatch(?:ed)?|ship(?:s|ped|ping)?)`;
const DELIVERY_TIME =
  String.raw`(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d+\s*(?:hours?|days?|weeks?)|\d{1,2}(?:st|nd|rd|th)|next day|same day|overnight)`;

/**
 * Two shapes, because a promise does not need a preposition to be a promise.
 * "arrives by Tuesday" and "gets to you tomorrow" commit the merchant equally.
 * The second pattern keeps a tight window so it does not fire on a stray weekday
 * mentioned elsewhere in the sentence.
 */
const DELIVERY_PROMISES = [
  new RegExp(
    String.raw`\b${DELIVERY_VERB}\b[^.!?]{0,40}\b(?:by|on|before|within|in)\b[^.!?]{0,20}\b${DELIVERY_TIME}\b`,
    'i'
  ),
  new RegExp(String.raw`\b${DELIVERY_VERB}\b[^.!?]{0,20}?\b${DELIVERY_TIME}\b`, 'i'),
];

const REFUND_PROMISE =
  /\b(?:full refund|refund you|we'?ll refund|money back|reimburse|we'?ll cover the|free returns?|return it free|no questions asked)\b/i;

const POLICY_EXCEPTION =
  /\b(?:make an exception|just this once|i'?ll (?:let|allow|waive)|we'?ll waive|off the record|between us|normally we (?:don'?t|wouldn'?t))\b/i;

/**
 * A promise is allowed only when the merchant's own policy was on the table.
 *
 * If `get_policy` was called this turn, the model had the real text in front of it
 * and we accept its paraphrase. If it was not, the promise came from nowhere — and
 * a delivery date the shop cannot hit is a complaint the merchant inherits.
 */
function checkUnfoundedPromises(input: GuardrailInput): GuardrailVerdict {
  const hasShipping = input.ledger.policies.has('shipping');
  const hasReturns = input.ledger.policies.has('returns');

  if (!hasShipping && DELIVERY_PROMISES.some((pattern) => pattern.test(input.text))) {
    return {
      action: 'block',
      guardrail: 'unfounded_promise',
      reason: 'The reply promised a delivery time that is not in your shipping policy.',
    };
  }

  if (REFUND_PROMISE.test(input.text) && !hasReturns) {
    return {
      action: 'block',
      guardrail: 'unfounded_promise',
      reason: 'The reply promised a refund or free return that is not in your returns policy.',
    };
  }

  if (POLICY_EXCEPTION.test(input.text)) {
    return {
      action: 'block',
      guardrail: 'unfounded_promise',
      reason: 'The reply offered an exception to your normal policy.',
    };
  }

  return { action: 'pass' };
}

// ---------------------------------------------------------------------------
// 6. Uncertainty
// ---------------------------------------------------------------------------

const HEDGE =
  /\b(?:i think|i believe|i'?m not (?:sure|certain)|not entirely sure|probably|possibly|might be|may be|should be(?: fine| ok(?:ay)?)?|as far as i know|i'?d guess|i assume|hopefully|it depends|can'?t say for (?:sure|certain))\b/i;

const SENSITIVE_TOPIC =
  /\b(?:refund|return|returns|policy|complaint|complain|damaged|faulty|broken|missing|never arrived|didn'?t arrive|wrong item|reaction|allergic|rash|irritat|dispute|chargeback|cancel(?:led|lation)?)\b/i;

/**
 * Hedging is fine about a colour. It is not fine about a refund. This catches the
 * combination — an uncertain answer on a subject where being wrong costs the
 * merchant a customer, a chargeback, or a review.
 */
function checkUncertainty(input: GuardrailInput): GuardrailVerdict {
  if (HEDGE.test(input.text) && SENSITIVE_TOPIC.test(input.text)) {
    return {
      action: 'block',
      guardrail: 'uncertainty',
      reason: 'The reply was unsure about a return, refund or complaint. Those need you.',
    };
  }

  return { action: 'pass' };
}

// ---------------------------------------------------------------------------
// 7. Length
// ---------------------------------------------------------------------------

function checkLength(input: GuardrailInput): GuardrailVerdict {
  if (input.text.length <= MAX_REPLY_LENGTH) return { action: 'pass' };

  if (input.isRetry) {
    return {
      action: 'block',
      guardrail: 'length',
      reason: `The reply was ${input.text.length} characters and did not shorten on a second attempt.`,
    };
  }

  return {
    action: 'retry_shorter',
    reason: `${input.text.length} characters, over the ${MAX_REPLY_LENGTH} limit.`,
  };
}

// ---------------------------------------------------------------------------

export const BREVITY_INSTRUCTION =
  'That reply was too long. Rewrite it in under three short sentences, keeping only what the shopper asked for. Do not add any new facts.';

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
