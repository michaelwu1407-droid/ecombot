import { supabaseAdmin } from './supabase/admin';
import type { InboundEvent } from './messaging';
import { logEvent } from './log';

/**
 * Turns a provider event into rows: customer, conversation, inbound message.
 *
 * Everything downstream — the agent, the metrics, the memory — reads these rows
 * rather than the provider payload, so this is the one place that has to get
 * identity and threading right.
 */

/**
 * How long a thread stays "the same conversation" for a returning shopper.
 * Matched to the Meta messaging window: inside 24 hours the agent can still
 * reply freely, so the exchange really is continuous.
 */
const RECENT_CONVERSATION_MS = 24 * 60 * 60 * 1000;

export interface IngestResult {
  merchantId: string;
  customerId: string;
  conversationId: string;
  messageId: string;
  /** True when this event opened the conversation, not continued one. */
  isNewConversation: boolean;
}

/** Provider delivery is at-least-once. Returns false when we have seen this id. */
export async function claimEvent(eventId: string, provider: string): Promise<boolean> {
  const { error } = await supabaseAdmin()
    .from('webhook_events')
    .insert({ event_id: eventId, provider });

  // 23505 = unique violation: another delivery of the same event won the race.
  if (error && error.code === '23505') return false;
  if (error) throw error;
  return true;
}

/**
 * Drops the claim so the provider's retry can reprocess the event.
 *
 * Claiming before processing is what stops a duplicate delivery sending a
 * customer two replies. The cost is that a claim held through a failed run would
 * bury the message permanently — a transient database blip would look exactly
 * like a customer who never wrote. Releasing on failure trades that for the
 * duplicate risk, which the retry backoff mostly absorbs and which is the
 * cheaper mistake: a shopper who waited and got nothing is a lost sale.
 */
export async function releaseEvent(eventId: string): Promise<void> {
  try {
    await supabaseAdmin().from('webhook_events').delete().eq('event_id', eventId);
  } catch (error) {
    console.error(`[webhook] failed to release claim on ${eventId}:`, error);
  }
}

/**
 * Maps the provider's account id to the merchant who owns that Instagram account.
 *
 * Returns the merchant whether or not they are live, because an inbound message is
 * still worth recording for a merchant who is paused or still setting up — they
 * should see the conversation when they come back. Whether the *agent* may act is a
 * separate question, answered by `agentMayReply`.
 */
export async function merchantForProviderAccount(providerAccountId: string): Promise<string | null> {
  const { data } = await supabaseAdmin()
    .from('connections')
    .select('merchant_id')
    .eq('kind', 'instagram')
    .eq('provider_account_id', providerAccountId)
    .eq('status', 'active')
    .maybeSingle();

  return data?.merchant_id ?? null;
}

export type ReplyBlock = 'not_live' | 'paused' | 'escalated' | 'merchant_took_over' | 'opted_out';

/**
 * A shopper asking to be left alone (§4.11: "permanently honour any negative
 * signal").
 *
 * Deliberately narrow. "Stop it 😂" mid-flirt with a boutique is not an opt-out, and
 * treating it as one silently loses a customer. What counts is an unambiguous
 * instruction to stop contacting them.
 */
const OPT_OUT =
  /\b(?:stop (?:messaging|contacting|texting|dm(?:'?ing)?) me|don'?t (?:message|contact|dm) me|unsubscribe|opt me out|leave me alone|remove me from (?:your )?(?:list|waitlist)|take me off (?:your )?list|no more messages)\b/i;

export function isOptOut(text: string): boolean {
  return OPT_OUT.test(text);
}

/**
 * Whether the agent is allowed to answer on this conversation right now.
 *
 * Checked in one place, on every path that could produce a reply, because each of
 * these was previously a way for the agent to speak when it should have stayed
 * quiet:
 *
 *   * **not_live** — she connects Instagram at step one of onboarding, long before
 *     she presses Go live. Without this the agent starts answering real customers
 *     before it has learned her voice or synced her catalogue.
 *   * **paused** — Pause is a safety control. It has to actually stop the agent, or
 *     it is worse than not having the button.
 *   * **escalated** — the agent has already told this shopper the owner will come
 *     back to them personally. Answering the next message itself makes that a lie.
 *   * **merchant_took_over** — she replied herself in the Instagram app. The agent
 *     does not talk over the owner in her own inbox.
 */
export async function agentMayReply(
  merchantId: string,
  conversationId: string
): Promise<{ allowed: true } | { allowed: false; reason: ReplyBlock }> {
  const db = supabaseAdmin();

  const [merchant, conversation] = await Promise.all([
    db.from('merchants').select('status').eq('id', merchantId).maybeSingle(),
    db
      .from('conversations')
      .select('status, merchant_took_over_at')
      .eq('id', conversationId)
      .eq('merchant_id', merchantId)
      .maybeSingle(),
  ]);

  const status = merchant.data?.status;
  if (status === 'paused') return { allowed: false, reason: 'paused' };
  if (status !== 'active') return { allowed: false, reason: 'not_live' };

  if (conversation.data?.status === 'escalated') {
    return { allowed: false, reason: 'escalated' };
  }

  if (conversation.data?.merchant_took_over_at) {
    return { allowed: false, reason: 'merchant_took_over' };
  }

  const { data: customer } = await db
    .from('conversations')
    .select('customers(opted_out_at)')
    .eq('id', conversationId)
    .maybeSingle();

  const optedOut = (customer?.customers as unknown as { opted_out_at: string | null } | null)
    ?.opted_out_at;
  if (optedOut) return { allowed: false, reason: 'opted_out' };

  return { allowed: true };
}

export async function ingestInboundEvent(event: InboundEvent): Promise<IngestResult | null> {
  const db = supabaseAdmin();

  const merchantId = await merchantForProviderAccount(event.providerAccountId);
  if (!merchantId) {
    // A connected account we do not have a merchant for. Worth seeing in health,
    // but not worth failing the delivery over — a retry would fail identically.
    await logEvent(null, 'inbound.unmapped_account', {
      providerAccountId: event.providerAccountId,
      eventId: event.eventId,
    });
    return null;
  }

  const customerId = await upsertCustomer(merchantId, event);
  const { conversationId, isNewConversation } = await resolveConversation(
    merchantId,
    customerId,
    event
  );

  const { data: message, error } = await db
    .from('messages')
    .insert({
      conversation_id: conversationId,
      direction: 'inbound',
      sender: 'customer',
      content: event.text,
      provider_message_id: event.eventId,
    })
    .select('id')
    .single();

  if (error) throw error;

  // last_inbound_at is what the 24-hour messaging window is measured from, so it
  // has to move on every inbound message, not only on new conversations.
  //
  // Clearing merchant_took_over_at here is what ends the stand-down: she answered,
  // the shopper has now replied to her, and the agent picks the thread back up with
  // her message in its history.
  await db
    .from('conversations')
    .update({
      last_message_at: event.timestamp.toISOString(),
      last_inbound_at: event.timestamp.toISOString(),
      merchant_took_over_at: null,
    })
    .eq('id', conversationId);

  // Honoured permanently, and honoured the moment it is said — before the agent
  // gets a chance to answer.
  if (isOptOut(event.text)) {
    await db
      .from('customers')
      .update({ opted_out_at: new Date().toISOString() })
      .eq('id', customerId)
      .is('opted_out_at', null);

    await db
      .from('waitlist_entries')
      .update({ status: 'expired' })
      .eq('customer_id', customerId)
      .eq('status', 'waiting');

    await logEvent(merchantId, 'customer.opted_out', { conversationId, customerId });
  }

  await logEvent(merchantId, 'inbound.received', {
    conversationId,
    type: event.type,
    eventId: event.eventId,
  });

  return {
    merchantId,
    customerId,
    conversationId,
    messageId: message.id,
    isNewConversation,
  };
}

/**
 * Records a message sent from the merchant's own account.
 *
 * Two things arrive on this path and they look identical on the wire: our own send
 * coming back as an echo, and the owner answering in the Instagram app. The only
 * thing that tells them apart is that ours was written to `messages` with its
 * provider id before the echo arrived.
 *
 * When it is hers, the agent stands down on that thread until the shopper writes
 * again — otherwise it answers a message she has already answered, in her own
 * inbox, possibly contradicting her.
 */
export async function ingestOutboundEvent(
  event: InboundEvent
): Promise<{ merchantId: string; conversationId: string; wasOurs: boolean } | null> {
  const db = supabaseAdmin();

  if (!event.providerMessageId) return null;

  const merchantId = await merchantForProviderAccount(event.providerAccountId);
  if (!merchantId) return null;

  // Ours. Nothing to do — it is already in the transcript.
  const { data: existing } = await db
    .from('messages')
    .select('id, conversation_id')
    .eq('provider_message_id', event.providerMessageId)
    .maybeSingle();

  if (existing) {
    return { merchantId, conversationId: existing.conversation_id, wasOurs: true };
  }

  // Hers. Find the thread it belongs to.
  const { data: conversation } = await db
    .from('conversations')
    .select('id')
    .eq('merchant_id', merchantId)
    .eq('provider_conversation_id', event.providerConversationId ?? '')
    .maybeSingle();

  if (!conversation) {
    // A thread we have never seen — she is talking to someone the agent has never
    // met. Nothing to stand down from.
    return null;
  }

  await db.from('messages').insert({
    conversation_id: conversation.id,
    direction: 'outbound',
    sender: 'merchant',
    content: event.text,
    provider_message_id: event.providerMessageId,
    status: 'sent',
  });

  await db
    .from('conversations')
    .update({
      merchant_took_over_at: event.timestamp.toISOString(),
      last_message_at: event.timestamp.toISOString(),
    })
    .eq('id', conversation.id);

  // A draft waiting for approval is now obsolete — she has already answered.
  await db
    .from('messages')
    .update({ status: 'superseded' })
    .eq('conversation_id', conversation.id)
    .in('status', ['pending_approval', 'blocked']);

  await logEvent(merchantId, 'conversation.merchant_took_over', {
    conversationId: conversation.id,
  });

  return { merchantId, conversationId: conversation.id, wasOurs: false };
}

async function upsertCustomer(merchantId: string, event: InboundEvent): Promise<string> {
  const db = supabaseAdmin();

  // Handle and name change over time; the platform id does not. Never overwrite a
  // known value with a null one — accumulated memory is the moat (§1.5).
  const patch: Record<string, unknown> = {
    merchant_id: merchantId,
    platform_user_id: event.senderId,
    last_seen_at: event.timestamp.toISOString(),
  };
  if (event.senderHandle) patch.handle = event.senderHandle;
  if (event.senderName) patch.name = event.senderName;

  const { data, error } = await db
    .from('customers')
    .upsert(patch, { onConflict: 'merchant_id,platform_user_id' })
    .select('id')
    .single();

  if (error) throw error;
  return data.id;
}

async function resolveConversation(
  merchantId: string,
  customerId: string,
  event: InboundEvent
): Promise<{ conversationId: string; isNewConversation: boolean }> {
  const db = supabaseAdmin();

  // A shopper who comments and then DMs within the hour is one person having one
  // conversation, so reuse the live thread rather than fragmenting their history.
  //
  // But only while it is genuinely live. A conversation carries the `source` it
  // was opened with, and that is what a sale gets attributed to (§2.7). Folding a
  // comment from a returning shopper into their months-old DM thread would credit
  // the sale to `dm` and lose the trace back to the post that earned it — which is
  // exactly the link §4.9 asks the merchant to be able to follow.
  const reuseCutoff = new Date(Date.now() - RECENT_CONVERSATION_MS).toISOString();

  const { data: existing } = await db
    .from('conversations')
    .select('id, status')
    .eq('merchant_id', merchantId)
    .eq('customer_id', customerId)
    .in('status', ['active', 'stalled', 'escalated'])
    .gte('last_message_at', reuseCutoff)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  if (existing) {
    // A stalled thread the customer has come back to is active again.
    if (existing.status === 'stalled') {
      await db.from('conversations').update({ status: 'active' }).eq('id', existing.id);
    }
    return { conversationId: existing.id, isNewConversation: false };
  }

  const { data, error } = await db
    .from('conversations')
    .insert({
      merchant_id: merchantId,
      customer_id: customerId,
      source: event.type,
      status: 'active',
      provider_conversation_id: event.providerConversationId ?? null,
      participant_id: event.senderId,
      last_message_at: event.timestamp.toISOString(),
      last_inbound_at: event.timestamp.toISOString(),
    })
    .select('id')
    .single();

  if (error) throw error;

  return { conversationId: data.id, isNewConversation: true };
}
