import { supabaseAdmin } from '../supabase/admin';
import { logEvent } from '../log';
import { checkProactiveLimits } from '../limits';
import { runShopperTurn } from '../agent/run';
import { decideRevival, MIN_STALL_MS, MAX_STALL_MS } from './eligibility';

/**
 * Dead thread revival (BUILD_SPEC §2.5).
 *
 * "Dead threads are recoverable revenue sitting in the inbox. She never circles
 * back." (§1.3) The revenue is already there and escaping — this is stopping a
 * leak, not creating demand (§1.4).
 *
 * One attempt per conversation, ever. A second is nagging, and nagging from a
 * merchant's own account is exactly what gets it restricted.
 */

const BATCH_SIZE = 25;

export interface RevivalResult {
  candidates: number;
  revived: number;
  queued: number;
  skipped: number;
}

export async function runDeadThreadSweep(
  merchantId: string,
  now: Date = new Date()
): Promise<RevivalResult> {
  const db = supabaseAdmin();
  const result: RevivalResult = { candidates: 0, revived: 0, queued: 0, skipped: 0 };

  const { data: conversations, error } = await db
    .from('conversations')
    .select('id, customer_id, last_message_at, last_inbound_at, outcome, revival_sent_at, status')
    .eq('merchant_id', merchantId)
    .in('status', ['stalled', 'active'])
    .is('outcome', null)
    .is('revival_sent_at', null)
    .lt('last_message_at', new Date(now.getTime() - MIN_STALL_MS).toISOString())
    .gt('last_message_at', new Date(now.getTime() - MAX_STALL_MS).toISOString())
    .order('last_message_at', { ascending: false })
    .limit(BATCH_SIZE);

  if (error) throw error;

  result.candidates = conversations?.length ?? 0;

  for (const conversation of conversations ?? []) {
    const decision = decideRevival(
      {
        lastMessageAt: conversation.last_message_at ? new Date(conversation.last_message_at) : null,
        lastInboundAt: conversation.last_inbound_at ? new Date(conversation.last_inbound_at) : null,
        outcome: conversation.outcome,
        revivalSentAt: conversation.revival_sent_at ? new Date(conversation.revival_sent_at) : null,
        status: conversation.status,
      },
      now
    );

    if (!decision.eligible) {
      // "Retire" means it will never become eligible, so stamp it and stop
      // reconsidering it every four hours.
      if (decision.retire) await markRevivalAttempted(conversation.id, now);
      result.skipped += 1;
      continue;
    }

    const limit = await checkProactiveLimits({ merchantId, customerId: conversation.customer_id, now });
    if (!limit.allowed) {
      result.skipped += 1;
      await logEvent(merchantId, 'revival.skipped', {
        conversationId: conversation.id,
        reason: limit.reason,
      });
      continue;
    }

    // Marked before sending, not after. A crash mid-turn must not leave a
    // conversation eligible for a second nudge on the next sweep.
    await markRevivalAttempted(conversation.id, now);

    const turn = await runShopperTurn({
      merchantId,
      conversationId: conversation.id,
      customerId: conversation.customer_id,
      proactive: {
        kind: 'revival',
        brief:
          'This conversation went quiet without a sale. Send one short, friendly follow-up that picks up ' +
          'where it left off — reference what they were actually looking at. Ask one easy question. ' +
          'Do not apologise for the delay, do not offer a discount, and do not push.',
      },
    });

    if (turn.outcome.status === 'sent') result.revived += 1;
    else if (turn.outcome.status === 'queued') result.queued += 1;
    else result.skipped += 1;
  }

  if (result.candidates > 0) {
    await logEvent(merchantId, 'revival.sweep_completed', { ...result });
  }

  return result;
}

async function markRevivalAttempted(conversationId: string, now: Date): Promise<void> {
  await supabaseAdmin()
    .from('conversations')
    .update({ revival_sent_at: now.toISOString() })
    .eq('id', conversationId);
}
