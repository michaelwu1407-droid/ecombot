import { createHash } from 'node:crypto';
import { supabaseAdmin } from './supabase/admin';
import { logEvent } from './log';

/**
 * Rate limits and daily caps, enforced in code (BUILD_SPEC §1.7, §4.6).
 *
 * "Getting a merchant's account restricted — their livelihood. Hard rate limits in
 * code, never in prompt." One restricted account ends the business by word of
 * mouth (§4.5), so these are numbers in a file, not sentences in a system prompt
 * that a model may or may not honour.
 *
 * The distinction that matters is reactive versus proactive:
 *
 *   * **Reactive** — someone messaged the shop and we answered. Meta expects this,
 *     shoppers expect this, and the volume is set by the shoppers themselves. The
 *     cap here is a circuit breaker for a loop gone wrong, not a business rule.
 *   * **Proactive** — we started it. This is where account standing is actually
 *     spent, so the limits are deliberately tight.
 */

export const LIMITS = {
  /** Circuit breaker on replies. A boutique with 20+ DMs a day is nowhere near this. */
  repliesPerMerchantPerHour: 120,

  /** Proactive sends across all jobs, per merchant, per rolling day. */
  proactivePerMerchantPerDay: 40,

  /** Proactive sends to one person. Twice in a week is pestering, not selling. */
  proactivePerCustomerPerWeek: 1,

  /** One revival attempt per conversation, ever. A second is nagging. */
  revivalsPerConversation: 1,

  /**
   * Private replies to comments, per merchant, per rolling day.
   *
   * This cap exists because the comment filter now optimises recall (§4.11): it
   * deliberately answers the ambiguous middle rather than staying quiet. That trade
   * only holds if volume is bounded somewhere else — a drop-day post with 200
   * comments must not turn into 200 unsolicited DMs from her account.
   */
  privateRepliesPerMerchantPerDay: 60,
} as const;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

const PROACTIVE_KINDS = ['revival', 'restock', 'operator_batch'];

export interface LimitDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * Randomised pause before a send, so a merchant's outbound traffic does not look
 * machine-generated (§4.11).
 *
 * Only applied to comment replies and proactive sends. A shopper who just messaged
 * is waiting, and speed is the product — delaying a direct reply to look human would
 * cost the thing she is paying for.
 */
export function humanisedDelayMs(random: () => number = Math.random): number {
  return Math.round(4_000 + random() * 11_000);
}

/**
 * Has this merchant's account already sent these exact words?
 *
 * Identical text repeated across recipients is one of the clearest automation
 * signals a platform can look for. Hashed rather than stored, so the index stays
 * small and the message text is not duplicated across tables.
 */
export async function isDuplicateText(
  merchantId: string,
  text: string,
  withinMs = 7 * DAY_MS
): Promise<boolean> {
  const { count, error } = await supabaseAdmin()
    .from('send_log')
    .select('id', { count: 'exact', head: true })
    .eq('merchant_id', merchantId)
    .eq('text_hash', hashText(text))
    .gte('created_at', new Date(Date.now() - withinMs).toISOString());

  if (error) throw error;
  return (count ?? 0) > 0;
}

export function hashText(text: string): string {
  // Normalised first, so trivial punctuation changes do not defeat the check.
  const normalised = text.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalised).digest('hex').slice(0, 32);
}

/** A shopper who asked to be left alone is left alone, permanently. */
export async function hasOptedOut(customerId: string): Promise<boolean> {
  const { data } = await supabaseAdmin()
    .from('customers')
    .select('opted_out_at')
    .eq('id', customerId)
    .maybeSingle();

  return Boolean(data?.opted_out_at);
}

/** Comment replies have their own daily ceiling — see LIMITS. */
export async function checkPrivateReplyLimit(
  merchantId: string,
  now: Date = new Date()
): Promise<LimitDecision> {
  const { count, error } = await supabaseAdmin()
    .from('send_log')
    .select('id', { count: 'exact', head: true })
    .eq('merchant_id', merchantId)
    .eq('kind', 'private_reply')
    .gte('created_at', new Date(now.getTime() - DAY_MS).toISOString());

  if (error) throw error;

  if ((count ?? 0) >= LIMITS.privateRepliesPerMerchantPerDay) {
    await logEvent(merchantId, 'limit.private_replies_per_day_hit', { count });
    return { allowed: false, reason: 'daily comment-reply cap reached' };
  }

  return { allowed: true };
}

/** Checked before every proactive send, per merchant and per recipient. */
export async function checkProactiveLimits(params: {
  merchantId: string;
  customerId: string;
  now?: Date;
}): Promise<LimitDecision> {
  const now = params.now ?? new Date();
  const db = supabaseAdmin();

  const { count: dailyCount, error: dailyError } = await db
    .from('send_log')
    .select('id', { count: 'exact', head: true })
    .eq('merchant_id', params.merchantId)
    .in('kind', PROACTIVE_KINDS)
    .gte('created_at', new Date(now.getTime() - DAY_MS).toISOString());

  if (dailyError) throw dailyError;

  if ((dailyCount ?? 0) >= LIMITS.proactivePerMerchantPerDay) {
    return {
      allowed: false,
      reason: `daily proactive cap reached (${LIMITS.proactivePerMerchantPerDay})`,
    };
  }

  const { count: customerCount, error: customerError } = await db
    .from('send_log')
    .select('id', { count: 'exact', head: true })
    .eq('merchant_id', params.merchantId)
    .eq('customer_id', params.customerId)
    .in('kind', PROACTIVE_KINDS)
    .gte('created_at', new Date(now.getTime() - WEEK_MS).toISOString());

  if (customerError) throw customerError;

  if ((customerCount ?? 0) >= LIMITS.proactivePerCustomerPerWeek) {
    return { allowed: false, reason: 'this customer was already contacted this week' };
  }

  return { allowed: true };
}

/** Circuit breaker on the reactive path, so a loop cannot flood an account. */
export async function checkReplyLimit(merchantId: string, now: Date = new Date()): Promise<LimitDecision> {
  const { count, error } = await supabaseAdmin()
    .from('send_log')
    .select('id', { count: 'exact', head: true })
    .eq('merchant_id', merchantId)
    .in('kind', ['reply', 'private_reply'])
    .gte('created_at', new Date(now.getTime() - HOUR_MS).toISOString());

  if (error) throw error;

  if ((count ?? 0) >= LIMITS.repliesPerMerchantPerHour) {
    await logEvent(merchantId, 'limit.replies_per_hour_hit', { count });
    return { allowed: false, reason: 'hourly reply limit reached' };
  }

  return { allowed: true };
}

/**
 * Has this conversation already had its one revival attempt?
 *
 * Read from a column rather than derived from the message log: the sweep runs
 * every four hours across every merchant, and inspecting JSON per row to answer
 * "did we already do this" is the kind of query that quietly gets expensive.
 */
export async function alreadyRevived(conversationId: string): Promise<boolean> {
  const { data } = await supabaseAdmin()
    .from('conversations')
    .select('revival_sent_at')
    .eq('id', conversationId)
    .maybeSingle();

  return Boolean(data?.revival_sent_at);
}
