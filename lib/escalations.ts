import { supabaseAdmin } from './supabase/admin';
import { logEvent } from './log';
import { getMessagingProvider, canPrivateReplyToComment } from './messaging';
import { checkReplyLimit } from './limits';

/**
 * The escalations queue (BUILD_SPEC §2.8 screen 2).
 *
 * This is the screen that makes suggest mode work, and suggest mode is the answer
 * to the objection that kills deals: "my customers love that it's personally me"
 * (§1.6). She watches it write like her for a week, then chooses to let go. So
 * this queue is a trust-building surface, not a error log — it has to read like
 * drafts awaiting her, not like failures awaiting triage.
 */

export interface PendingReply {
  messageId: string;
  conversationId: string;
  customerId: string;
  handle: string | null;
  name: string | null;
  draft: string;
  /** Null for an ordinary suggest-mode draft; set when something needs attention. */
  blockedReason: string | null;
  status: 'pending_approval' | 'blocked';
  createdAt: string;
  /**
   * The recent thread, so she can judge a draft without opening Instagram.
   * Read-only, and deliberately not an inbox (§2.8) — she is being asked to approve
   * something, and approving a reply to a complaint without seeing the complaint is
   * not a decision she can actually make.
   */
  thread: ThreadMessage[];
  source: string;
}

export interface ThreadMessage {
  id: string;
  from: 'customer' | 'agent' | 'merchant';
  content: string;
  createdAt: string;
}

/** Enough to judge a reply; not so much that the card becomes an inbox. */
const THREAD_LIMIT = 10;

export async function getPendingReplies(merchantId: string, limit = 50): Promise<PendingReply[]> {
  const db = supabaseAdmin();

  const { data, error } = await db
    .from('messages')
    .select(
      'id, conversation_id, content, blocked_reason, status, created_at, conversations!inner(merchant_id, customer_id, source, customers(handle, name))'
    )
    .eq('conversations.merchant_id', merchantId)
    .in('status', ['pending_approval', 'blocked'])
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) throw error;

  const rows = data ?? [];

  const conversationIds = [...new Set(rows.map((row) => row.conversation_id))];
  const threads = await getThreads(conversationIds);

  return rows.map((row) => {
    const conversation = row.conversations as unknown as {
      customer_id: string;
      source: string;
      customers: { handle: string | null; name: string | null } | null;
    };

    return {
      messageId: row.id,
      conversationId: row.conversation_id,
      customerId: conversation.customer_id,
      handle: conversation.customers?.handle ?? null,
      name: conversation.customers?.name ?? null,
      draft: row.content,
      blockedReason: row.blocked_reason,
      status: row.status as 'pending_approval' | 'blocked',
      createdAt: row.created_at,
      thread: threads.get(row.conversation_id) ?? [],
      source: conversation.source,
    };
  });
}

/**
 * The recent exchange per conversation, oldest first.
 *
 * Only what the shopper actually saw: drafts awaiting approval, blocked replies and
 * superseded ones are excluded, because showing her a message the customer never
 * received would make the thread a lie.
 */
async function getThreads(conversationIds: string[]): Promise<Map<string, ThreadMessage[]>> {
  if (!conversationIds.length) return new Map();

  const { data } = await supabaseAdmin()
    .from('messages')
    .select('id, conversation_id, sender, content, created_at, status')
    .in('conversation_id', conversationIds)
    .eq('status', 'sent')
    .order('created_at', { ascending: false });

  const threads = new Map<string, ThreadMessage[]>();

  for (const row of data ?? []) {
    const existing = threads.get(row.conversation_id) ?? [];
    if (existing.length >= THREAD_LIMIT) continue;

    existing.push({
      id: row.id,
      from: row.sender as ThreadMessage['from'],
      content: row.content,
      createdAt: row.created_at,
    });
    threads.set(row.conversation_id, existing);
  }

  // Collected newest-first to respect the limit; read oldest-first.
  for (const [id, messages] of threads) threads.set(id, messages.reverse());

  return threads;
}

export type ApprovalResult =
  | { ok: true; sent: true }
  | { ok: false; error: string };

/**
 * Sends a queued draft, optionally after the merchant edited it.
 *
 * An edit is not just a send — it is the clearest signal we get about how she
 * actually writes, so it is logged for the voice examples that shape future
 * drafts (§1.6).
 */
export async function approveReply(params: {
  merchantId: string;
  messageId: string;
  editedText?: string;
}): Promise<ApprovalResult> {
  const db = supabaseAdmin();

  const { data: message } = await db
    .from('messages')
    .select(
      'id, conversation_id, content, status, conversations!inner(merchant_id, participant_id, origin_comment_id, origin_post_id, created_at)'
    )
    .eq('id', params.messageId)
    .eq('conversations.merchant_id', params.merchantId)
    .maybeSingle();

  if (!message) return { ok: false, error: 'not found' };
  if (message.status === 'sent') return { ok: false, error: 'already sent' };

  const conversation = message.conversations as unknown as {
    merchant_id: string;
    participant_id: string | null;
    origin_comment_id: string | null;
    origin_post_id: string | null;
    created_at: string;
  };

  // The account-standing circuit breaker applies to approvals too. Meta judges
  // the account's behaviour, not who typed the message — and 120 approvals in an
  // hour is not a person tapping send.
  const limit = await checkReplyLimit(params.merchantId);
  if (!limit.allowed) {
    return { ok: false, error: 'Paused briefly — too many messages this hour. Try again shortly.' };
  }

  const { data: connection } = await db
    .from('connections')
    .select('provider_account_id')
    .eq('merchant_id', params.merchantId)
    .eq('kind', 'instagram')
    .eq('status', 'active')
    .maybeSingle();

  if (!connection?.provider_account_id || !conversation.participant_id) {
    return { ok: false, error: 'Instagram is not connected' };
  }

  const text = (params.editedText ?? message.content).trim();
  if (!text) return { ok: false, error: 'nothing to send' };

  const wasEdited = Boolean(params.editedText && params.editedText.trim() !== message.content.trim());

  // A conversation that began as a comment has to be opened through the private
  // reply endpoint — Instagram rejects an unsolicited DM to someone who has only
  // commented. Once anything has gone out, the thread exists and normal DMs work.
  const needsPrivateReply =
    Boolean(conversation.origin_comment_id) && !(await hasSentOutbound(message.conversation_id));

  if (
    needsPrivateReply &&
    !canPrivateReplyToComment(new Date(conversation.created_at))
  ) {
    return {
      ok: false,
      error: 'Too late to reply to this comment — Instagram allows 7 days, and that has passed.',
    };
  }

  try {
    const provider = getMessagingProvider();
    const result = needsPrivateReply
      ? await provider.sendPrivateReplyToComment(
          connection.provider_account_id,
          conversation.origin_comment_id!,
          text,
          conversation.origin_post_id ?? undefined
        )
      : await provider.sendMessage(connection.provider_account_id, conversation.participant_id, text);

    await db
      .from('messages')
      .update({
        content: text,
        status: 'sent',
        approved_at: new Date().toISOString(),
        provider_message_id: result.messageId,
        // An approved message is the merchant's, whoever drafted it.
        sender: 'merchant',
      })
      .eq('id', params.messageId);

    await db.from('send_log').insert({ merchant_id: params.merchantId, kind: 'reply' });

    await db
      .from('conversations')
      .update({ last_message_at: new Date().toISOString() })
      .eq('id', message.conversation_id);

    await recordFirstResponseOnApproval(params.merchantId, message.conversation_id);

    await logEvent(params.merchantId, 'reply.approved', {
      conversationId: message.conversation_id,
      edited: wasEdited,
      // The edit itself is the signal — what she changed is how she writes.
      ...(wasEdited ? { original: message.content, sent: text } : {}),
    });

    return { ok: true, sent: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await logEvent(params.merchantId, 'reply.approval_send_failed', {
      conversationId: message.conversation_id,
      message: detail,
    });
    return { ok: false, error: detail };
  }
}

export async function dismissReply(merchantId: string, messageId: string): Promise<void> {
  const db = supabaseAdmin();

  const { data: message } = await db
    .from('messages')
    .select('id, conversation_id, conversations!inner(merchant_id)')
    .eq('id', messageId)
    .eq('conversations.merchant_id', merchantId)
    .maybeSingle();

  if (!message) return;

  await db.from('messages').update({ status: 'dismissed' }).eq('id', messageId);

  await logEvent(merchantId, 'reply.dismissed', { conversationId: message.conversation_id });
}

/** Has anything already reached this shopper on this thread? */
async function hasSentOutbound(conversationId: string): Promise<boolean> {
  const { count } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversationId)
    .eq('direction', 'outbound')
    .eq('status', 'sent');

  return (count ?? 0) > 0;
}

async function recordFirstResponseOnApproval(merchantId: string, conversationId: string): Promise<void> {
  const db = supabaseAdmin();

  const { data: conversation } = await db
    .from('conversations')
    .select('first_response_seconds')
    .eq('id', conversationId)
    .maybeSingle();

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

  await db
    .from('conversations')
    .update({
      first_response_seconds: Math.max(
        0,
        Math.round((Date.now() - new Date(firstInbound.created_at).getTime()) / 1000)
      ),
    })
    .eq('id', conversationId)
    .is('first_response_seconds', null);
}
