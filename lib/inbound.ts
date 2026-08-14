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
  /** Set when the merchant has never been replied to on this thread. */
  awaitingFirstResponseSince: Date | null;
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

/** Maps the provider's account id to the merchant who owns that Instagram account. */
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
  const { conversationId, isNewConversation, awaitingFirstResponseSince } = await resolveConversation(
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
  await db
    .from('conversations')
    .update({ last_message_at: event.timestamp.toISOString(), last_inbound_at: event.timestamp.toISOString() })
    .eq('id', conversationId);

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
    awaitingFirstResponseSince,
  };
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
): Promise<{ conversationId: string; isNewConversation: boolean; awaitingFirstResponseSince: Date | null }> {
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
    .select('id, status, first_response_seconds, created_at')
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
    return {
      conversationId: existing.id,
      isNewConversation: false,
      awaitingFirstResponseSince:
        existing.first_response_seconds === null ? new Date(existing.created_at) : null,
    };
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
    .select('id, created_at')
    .single();

  if (error) throw error;

  return {
    conversationId: data.id,
    isNewConversation: true,
    // Response time is the headline metric (§2.7), measured from the moment the
    // customer wrote — not from when our infrastructure got around to it.
    awaitingFirstResponseSince: event.timestamp,
  };
}
