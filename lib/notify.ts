import { supabaseAdmin } from './supabase/admin';
import { logEvent } from './log';
import { getMessagingProvider } from './messaging';

/**
 * Telling the merchant a draft is waiting (C4).
 *
 * Every new merchant starts in suggest mode (§3.4), so every reply waits for her.
 * Until this existed there was no notification of any kind, which meant a
 * suggest-mode merchant was **slower than before Earlymark** — Instagram at least
 * used to buzz her phone. The product's whole claim is speed (§1.4), so this is not
 * a nicety, it is the difference between the pitch being true and false.
 *
 * Sent from Earlymark's own WhatsApp/Instagram account to hers, through the same
 * messaging abstraction the shopper agent uses (§4.2) — no second integration.
 *
 * **Meta constraint.** This is a business-initiated message to someone who has not
 * just messaged us, so it falls outside the 24-hour window and cannot be freeform.
 * WhatsApp requires a pre-approved utility template; the text below is written to
 * match one, with the count and the link as the two variables. Until that template
 * is approved, sending will fail — which is why failures here are logged and
 * swallowed rather than allowed to break the agent turn that triggered them.
 */

/** One message per merchant per window, however many drafts arrive. */
export const NOTIFY_WINDOW_MS = 10 * 60 * 1000;

export interface NotifyResult {
  sent: boolean;
  reason?: 'no_channel' | 'too_soon' | 'nothing_pending' | 'send_failed' | 'not_configured';
}

/**
 * Called after a draft is queued. Batches deliberately: a shopper sending four
 * messages in a minute should buzz her once, not four times. Being pestered by the
 * thing that promised to give her her evenings back is its own kind of failure.
 */
export async function notifyDraftWaiting(merchantId: string): Promise<NotifyResult> {
  const db = supabaseAdmin();

  const account = process.env.EARLYMARK_NOTIFY_ACCOUNT_ID;
  if (!account) return { sent: false, reason: 'not_configured' };

  const { data: merchant } = await db
    .from('merchants')
    .select('notify_participant_id, notified_at, business_name')
    .eq('id', merchantId)
    .maybeSingle();

  // She has not told us where to reach her yet. Onboarding asks for this.
  if (!merchant?.notify_participant_id) return { sent: false, reason: 'no_channel' };

  if (
    merchant.notified_at &&
    Date.now() - new Date(merchant.notified_at).getTime() < NOTIFY_WINDOW_MS
  ) {
    return { sent: false, reason: 'too_soon' };
  }

  const { count } = await db
    .from('messages')
    .select('id, conversations!inner(merchant_id)', { count: 'exact', head: true })
    .eq('conversations.merchant_id', merchantId)
    .in('status', ['pending_approval', 'blocked']);

  const waiting = count ?? 0;
  if (waiting === 0) return { sent: false, reason: 'nothing_pending' };

  // Stamped before sending, so a provider that is slow or flaky cannot produce a
  // burst of duplicate notifications.
  await db
    .from('merchants')
    .update({ notified_at: new Date().toISOString() })
    .eq('id', merchantId);

  try {
    await getMessagingProvider().sendMessage(
      account,
      merchant.notify_participant_id,
      draftWaitingMessage(waiting)
    );

    await logEvent(merchantId, 'notify.sent', { waiting });
    return { sent: true };
  } catch (error) {
    await logEvent(merchantId, 'notify.failed', {
      waiting,
      message: error instanceof Error ? error.message : String(error),
    });
    return { sent: false, reason: 'send_failed' };
  }
}

/**
 * Written to match a WhatsApp utility template with two variables: the count and
 * the link. Keep the shape stable — changing the wording means resubmitting the
 * template to Meta for approval.
 */
export function draftWaitingMessage(waiting: number): string {
  const url = `${process.env.NEXT_PUBLIC_APP_URL ?? 'https://earlymark.ai'}/escalations`;
  const noun = waiting === 1 ? 'reply is' : 'replies are';
  return `${waiting} ${noun} ready for you to check. ${url}`;
}
