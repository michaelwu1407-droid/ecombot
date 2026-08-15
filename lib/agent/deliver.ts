import { supabaseAdmin } from '../supabase/admin';
import { logEvent } from '../log';
import { getMessagingProvider, isWithinMessagingWindow, MessagingError } from '../messaging';
import { runGuardrails } from './guardrails';
import { checkReplyLimit } from '../limits';
import { notifyDraftWaiting } from '../notify';
import type { AgentConfig, TurnLedger } from './types';

/**
 * The single exit point for anything the agent says to a customer.
 *
 * Everything funnels through here so the checks that protect the merchant cannot
 * be bypassed by a new code path: suggest mode, the messaging window, and the
 * send log that rate limits depend on.
 */

export type DeliveryOutcome =
  | { status: 'sent'; providerMessageId: string; messageId: string }
  | { status: 'queued'; messageId: string; reason: 'suggest_mode' | 'blocked' | 'window_closed' }
  | { status: 'failed'; error: string };

export interface DeliveryRequest {
  merchantId: string;
  conversationId: string;
  text: string;
  /** Tool calls made this turn, recorded on the message for the audit trail. */
  toolCalls?: unknown;
  /** Set when the caller already blocked it; forces the queue and records why. */
  blockedReason?: string;
  kind: 'reply' | 'private_reply' | 'revival' | 'restock' | 'operator_batch';
  /**
   * What tools established, and the merchant's rules. Required, because the
   * guardrails run here — see below.
   */
  ledger: TurnLedger;
  config: AgentConfig;
  /**
   * Set for a private reply to a comment. Meta allows exactly one per comment,
   * and it opens a thread with someone who has never messaged the shop — so it
   * goes out through the comment endpoint, not as a plain DM.
   */
  comment?: { commentId: string; postId: string };
}

export async function deliverReply(request: DeliveryRequest): Promise<DeliveryOutcome> {
  const db = supabaseAdmin();

  /**
   * The guardrails run here, at the exit, not only in the caller.
   *
   * The shopper loop already runs them — it has to, because the length check
   * needs a model call to retry. Running them again costs nothing (pure regex)
   * and buys the property that matters: every future send path — private replies
   * to comments, restock notices, dead-thread revivals, whatever stage comes
   * next — is covered by construction rather than by the author remembering.
   *
   * A proactive send passes an empty ledger, which means a price in a restock
   * notice is blocked unless something looked it up. That is the correct answer.
   */
  const verdict = runGuardrails({
    text: request.text,
    ledger: request.ledger,
    config: request.config,
    // The caller owns the one permitted retry; by here the text is final.
    isRetry: true,
  });

  const blockedReason =
    request.blockedReason ?? (verdict.action === 'block' ? verdict.reason : undefined);

  if (verdict.action === 'block' && !request.blockedReason) {
    await logEvent(request.merchantId, 'guardrail.blocked_at_delivery', {
      conversationId: request.conversationId,
      guardrail: verdict.guardrail,
      reason: verdict.reason,
      kind: request.kind,
    });
  }

  const { data: conversation, error } = await db
    .from('conversations')
    .select('id, participant_id, source, last_inbound_at, customer_id')
    .eq('id', request.conversationId)
    .eq('merchant_id', request.merchantId)
    .single();

  if (error || !conversation) return { status: 'failed', error: 'conversation not found' };

  const { data: config } = await db
    .from('agent_configs')
    .select('auto_send')
    .eq('merchant_id', request.merchantId)
    .single();

  const { data: connection } = await db
    .from('connections')
    .select('provider_account_id')
    .eq('merchant_id', request.merchantId)
    .eq('kind', 'instagram')
    .eq('status', 'active')
    .maybeSingle();

  // Reasons a draft is queued rather than sent, most important first.
  const queueReason = decideQueueReason({
    blocked: Boolean(blockedReason),
    autoSend: config?.auto_send === true,
    lastInboundAt: conversation.last_inbound_at ? new Date(conversation.last_inbound_at) : null,
    isPrivateReply: Boolean(request.comment),
  });

  if (queueReason) {
    // A second shopper message used to produce a second, independent draft that
    // could not see the first — two replies on one thread that might disagree, and
    // approving both sent both. The newest draft has the whole conversation in it,
    // so the older one is retired rather than left waiting.
    await db
      .from('messages')
      .update({ status: 'superseded' })
      .eq('conversation_id', request.conversationId)
      .in('status', ['pending_approval', 'blocked']);

    const messageId = await recordMessage(request, {
      status: queueReason === 'blocked' ? 'blocked' : 'pending_approval',
      blockedReason: blockedReason ?? queueReasonText(queueReason),
      providerMessageId: null,
    });

    await logEvent(request.merchantId, 'reply.queued', {
      conversationId: request.conversationId,
      reason: queueReason,
    });

    // A draft nobody knows about is a shopper waiting. Batched, and never allowed
    // to fail the turn that produced it.
    await notifyDraftWaiting(request.merchantId);

    return { status: 'queued', messageId, reason: queueReason };
  }

  if (!connection?.provider_account_id) {
    return { status: 'failed', error: 'no connected Instagram account for this conversation' };
  }

  // Last gate before the wire. Enforced here rather than in the callers so a loop
  // gone wrong cannot flood a merchant's account through some path that forgot to
  // ask (§1.7). Proactive caps are checked by the jobs, which need to know before
  // they spend a model call drafting.
  const replyLimit = await checkReplyLimit(request.merchantId);
  if (!replyLimit.allowed) {
    const messageId = await recordMessage(request, {
      status: 'blocked',
      blockedReason: 'Paused briefly — the agent hit its hourly sending limit. This is a safety limit on your account.',
      providerMessageId: null,
    });
    return { status: 'queued', messageId, reason: 'blocked' };
  }
  if (!request.comment && !conversation.participant_id) {
    return { status: 'failed', error: 'conversation has no participant to reply to' };
  }

  try {
    const provider = getMessagingProvider();

    const result = request.comment
      ? await provider.sendPrivateReplyToComment(
          connection.provider_account_id,
          request.comment.commentId,
          request.text,
          request.comment.postId
        )
      : await provider.sendMessage(
          connection.provider_account_id,
          conversation.participant_id!,
          request.text
        );

    const messageId = await recordMessage(request, {
      status: 'sent',
      blockedReason: null,
      providerMessageId: result.messageId,
    });

    // Feeds the rate limits and daily caps enforced in code (§1.7).
    await db.from('send_log').insert({
      merchant_id: request.merchantId,
      kind: request.kind,
      customer_id: conversation.customer_id,
    });

    if (result.conversationId) {
      await db
        .from('conversations')
        .update({ provider_conversation_id: result.conversationId })
        .eq('id', request.conversationId);
    }

    await recordFirstResponse(request.merchantId, request.conversationId);

    return { status: 'sent', providerMessageId: result.messageId, messageId };
  } catch (sendError) {
    const message = sendError instanceof MessagingError ? sendError.message : String(sendError);
    await logEvent(request.merchantId, 'reply.send_failed', {
      conversationId: request.conversationId,
      message,
    });
    return { status: 'failed', error: message };
  }
}

function decideQueueReason(params: {
  blocked: boolean;
  autoSend: boolean;
  lastInboundAt: Date | null;
  isPrivateReply: boolean;
}): 'blocked' | 'suggest_mode' | 'window_closed' | null {
  if (params.blocked) return 'blocked';
  if (!params.autoSend) return 'suggest_mode';

  // A private reply to a comment runs on its own clock — 7 days from the comment,
  // not 24 hours from a DM the person has never sent. Applying the DM window here
  // would queue every single comment reply, which is the whole feature.
  // canPrivateReplyToComment is checked before the reply is drafted, in the
  // capture path, so by here it is already known to be inside its window.
  if (params.isPrivateReply) return null;

  // Outside 24 hours Meta only delivers under a tag scoped to human agents, so
  // the merchant approves it and the tag stays honest (see lib/messaging/window.ts).
  if (!isWithinMessagingWindow(params.lastInboundAt)) return 'window_closed';
  return null;
}

function queueReasonText(reason: 'blocked' | 'suggest_mode' | 'window_closed'): string | null {
  switch (reason) {
    case 'suggest_mode':
      return null; // Not a problem — this is the default mode, awaiting approval.
    case 'window_closed':
      return 'Instagram only delivers this if you approve it — the shopper last messaged over 24 hours ago.';
    default:
      return null;
  }
}

/**
 * Median time to first reply is the headline metric (§2.7), so it is measured
 * from when the shopper wrote — not from when we got round to it.
 *
 * Recorded here rather than in the agent loop because a draft that sits in
 * suggest mode has not answered anybody yet. Every new merchant starts in suggest
 * mode (§3.4), so timing the draft would report a response time no shopper
 * experienced. The clock stops when a message actually goes out, whether the
 * agent sent it or the merchant approved it.
 */
async function recordFirstResponse(merchantId: string, conversationId: string): Promise<void> {
  const db = supabaseAdmin();

  const { data: conversation } = await db
    .from('conversations')
    .select('first_response_seconds')
    .eq('id', conversationId)
    .single();

  if (!conversation || conversation.first_response_seconds !== null) return;

  const { data: firstInbound } = await db
    .from('messages')
    .select('created_at')
    .eq('conversation_id', conversationId)
    .eq('direction', 'inbound')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!firstInbound) return;

  const seconds = Math.max(
    0,
    Math.round((Date.now() - new Date(firstInbound.created_at).getTime()) / 1000)
  );

  await db
    .from('conversations')
    .update({ first_response_seconds: seconds })
    .eq('id', conversationId)
    .is('first_response_seconds', null);

  await logEvent(merchantId, 'conversation.first_response', { conversationId, seconds });
}

async function recordMessage(
  request: DeliveryRequest,
  state: { status: string; blockedReason: string | null; providerMessageId: string | null }
): Promise<string> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .insert({
      conversation_id: request.conversationId,
      direction: 'outbound',
      sender: 'agent',
      content: request.text,
      tool_calls: request.toolCalls ?? null,
      provider_message_id: state.providerMessageId,
      status: state.status,
      blocked_reason: state.blockedReason,
    })
    .select('id')
    .single();

  if (error) throw error;
  return data.id;
}
