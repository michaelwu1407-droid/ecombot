import { supabaseAdmin } from './supabase/admin';
import { logEvent } from './log';

/**
 * Conversation status transitions (§4.6, hourly).
 *
 * `stalled` is what makes dead-thread revival possible — a conversation that went
 * quiet without a sale is recoverable revenue sitting in the inbox (§1.3).
 */

/** A thread with no activity for this long has gone quiet. */
export const STALL_AFTER_MS = 24 * 60 * 60 * 1000;

export async function markStalledConversations(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STALL_AFTER_MS).toISOString();

  // Escalated threads are the merchant's, not ours, so they are left alone.
  const { data, error } = await supabaseAdmin()
    .from('conversations')
    .update({ status: 'stalled' })
    .eq('status', 'active')
    .lt('last_message_at', cutoff)
    .is('outcome', null)
    .select('id, merchant_id');

  if (error) throw error;

  for (const conversation of data ?? []) {
    await logEvent(conversation.merchant_id, 'conversation.stalled', {
      conversationId: conversation.id,
    });
  }

  return data?.length ?? 0;
}
