import { supabaseAdmin } from '../supabase/admin';
import { logEvent } from '../log';
import { canPrivateReplyToComment, type InboundEvent } from '../messaging';
import { agentMayReply, ingestInboundEvent, merchantForProviderAccount } from '../inbound';
import { classifyComment } from './intent';
import { runShopperTurn } from '../agent/run';

/**
 * Turning a public comment into a private conversation (BUILD_SPEC §2.3).
 *
 * "Comment capture is not optional. It is the largest leak in the merchant's day."
 * Forty-seven comments arrive on a lunchtime post, nine of them are buying
 * signals, and most never become conversations.
 *
 * Gates, in order, cheapest first:
 *
 *   1. Not the merchant's own comment.
 *   2. Not already handled — Meta allows one private reply per comment, ever, and
 *      a second attempt is a hard rejection.
 *   3. Still inside the comment's 7-day reply window.
 *   4. Actually a buying signal.
 *
 * The claim in gate 2 is taken *before* the intent check, so two concurrent
 * deliveries of the same comment cannot both decide to reply. Its outcome is
 * updated afterwards to say what we actually did.
 */

export type CommentSkipReason =
  | 'already_handled'
  | 'window_expired'
  | 'no_intent'
  | 'own_comment'
  | 'unmapped';

export type CommentOutcome =
  | { handled: true; conversationId: string }
  | { handled: false; reason: CommentSkipReason };

export async function handleCommentEvent(event: InboundEvent): Promise<CommentOutcome> {
  if (event.type !== 'comment' || !event.commentId || !event.postId) {
    return { handled: false, reason: 'no_intent' };
  }

  // The merchant answering under their own post is not a lead.
  if (event.senderId === event.providerAccountId) {
    return { handled: false, reason: 'own_comment' };
  }

  const merchantId = await merchantForProviderAccount(event.providerAccountId);
  if (!merchantId) {
    await logEvent(null, 'comment.unmapped_account', {
      providerAccountId: event.providerAccountId,
      commentId: event.commentId,
    });
    return { handled: false, reason: 'unmapped' };
  }

  const claimed = await claimComment(event, merchantId);
  if (!claimed) return { handled: false, reason: 'already_handled' };

  if (!canPrivateReplyToComment(event.timestamp)) {
    await setCommentOutcome(event.commentId, 'skipped_window');
    return { handled: false, reason: 'window_expired' };
  }

  // Every comment is scored and recorded, answered or not. The ones we turn down
  // are most of the training set's value — see §4.13.
  const decision = await classifyComment(event.text);

  await supabaseAdmin()
    .from('comment_events')
    .update({
      filter_stage: decision.stage,
      classifier_confidence: decision.confidence,
      exploration: decision.exploration,
    })
    .eq('comment_id', event.commentId);

  if (decision.intent !== 'buying') {
    await setCommentOutcome(event.commentId, 'skipped_no_intent');
    return { handled: false, reason: 'no_intent' };
  }

  // Only a buying signal becomes a conversation. Everything else stays a comment.
  const ingested = await ingestInboundEvent(event);
  if (!ingested) {
    await setCommentOutcome(event.commentId, 'failed');
    return { handled: false, reason: 'unmapped' };
  }

  await supabaseAdmin()
    .from('comment_events')
    .update({ conversation_id: ingested.conversationId, outcome: 'replied', replied: true })
    .eq('comment_id', event.commentId);

  // Stored on the conversation so a draft approved later still goes out through
  // the private-reply endpoint. An unsolicited DM to someone who only commented
  // is rejected by Instagram, so this is the only route that works.
  await supabaseAdmin()
    .from('conversations')
    .update({ origin_comment_id: event.commentId, origin_post_id: event.postId })
    .eq('id', ingested.conversationId)
    .is('origin_comment_id', null);

  await logEvent(merchantId, 'comment.captured', {
    commentId: event.commentId,
    conversationId: ingested.conversationId,
    stage: decision.stage,
    exploration: decision.exploration,
  });

  // Same gate as the DM path: a paused shop, or one that has not gone live, does
  // not answer comments either.
  const permission = await agentMayReply(ingested.merchantId, ingested.conversationId);
  if (!permission.allowed) {
    await logEvent(merchantId, 'agent.stood_down', {
      conversationId: ingested.conversationId,
      reason: permission.reason,
      source: 'comment',
    });
    return { handled: false, reason: 'no_intent' };
  }

  await runShopperTurn({
    merchantId: ingested.merchantId,
    conversationId: ingested.conversationId,
    customerId: ingested.customerId,
    // Routes the reply through the comment endpoint rather than as a plain DM.
    comment: { commentId: event.commentId, postId: event.postId },
  });

  return { handled: true, conversationId: ingested.conversationId };
}

/** Returns false when another delivery already claimed this comment. */
async function claimComment(event: InboundEvent, merchantId: string): Promise<boolean> {
  const { error } = await supabaseAdmin().from('comment_events').insert({
    comment_id: event.commentId!,
    merchant_id: merchantId,
    post_id: event.postId,
    comment_text: event.text,
    commenter_platform_id: event.senderId,
    outcome: 'pending',
  });

  // 23505 = unique violation: someone else got there first.
  if (error?.code === '23505') return false;
  if (error) throw error;
  return true;
}

async function setCommentOutcome(commentId: string, outcome: string): Promise<void> {
  await supabaseAdmin().from('comment_events').update({ outcome }).eq('comment_id', commentId);
}

/**
 * A claim that was never resolved means the run died between claiming a comment and
 * answering it. Left alone, that comment is claimed forever and never retried — a
 * silently lost lead, in the feature the spec calls the biggest leak.
 */
export async function releaseStuckComments(olderThanMs = 60 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();

  const { data } = await supabaseAdmin()
    .from('comment_events')
    .delete()
    .eq('outcome', 'pending')
    .lt('created_at', cutoff)
    .select('comment_id');

  return data?.length ?? 0;
}
