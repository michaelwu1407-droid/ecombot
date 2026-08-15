import { after } from 'next/server';
import { getMessagingProvider } from '@/lib/messaging';
import { runShopperTurn } from '@/lib/agent/run';
import { handleCommentEvent } from '@/lib/capture/comments';
import { allowWebhook } from '@/lib/webhook-rate-limit';
import { claimEvent, ingestInboundEvent, releaseEvent } from '@/lib/inbound';
import { logEvent } from '@/lib/log';

/**
 * Inbound messaging webhook (BUILD_SPEC §4.7 step 1).
 *
 * The work is split across the response boundary on purpose:
 *
 *   * Persisting the message runs *before* we answer. It is a handful of database
 *     round trips, comfortably inside the provider's 5-second ack budget, and
 *     doing it here means a failure returns non-2xx and earns a real retry. A
 *     customer's message is never lost to a transient blip.
 *
 *   * The agent turn runs in `after()`, which keeps the function alive past the
 *     response. That is what lets us hold a sub-five-second reply (§1.4) without
 *     the queue service the stack list forbids (§4.1).
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const provider = getMessagingProvider();

  // Signature first, against the raw bytes, before anything is parsed or trusted.
  if (!(await provider.verifyWebhook(req))) {
    return Response.json({ error: 'invalid signature' }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: 'invalid json' }, { status: 400 });
  }

  const event = provider.parseInboundEvent(payload);

  // Limited per account, after the signature check — a signed payload is from the
  // provider, so this is shedding a redelivery storm, not repelling an attacker.
  // 429 asks them to back off and retry rather than dropping the message.
  if (event && !allowWebhook(event.providerAccountId)) {
    return Response.json({ error: 'slow down' }, { status: 429 });
  }

  // Events we do not act on — a delivery receipt, a non-Instagram account, an
  // outbound echo — are acknowledged. Returning an error would earn seven retries
  // of something we will never handle.
  if (!event) return Response.json({ ok: true, ignored: true });

  // Delivery is at-least-once. Claiming before processing means a duplicate is
  // dropped here rather than sending a customer the same reply twice.
  let claimed: boolean;
  try {
    claimed = await claimEvent(event.eventId, provider.name);
  } catch (error) {
    // Cannot tell a duplicate from a fresh event, so ask for the retry.
    console.error('[webhook] could not claim event', error);
    return Response.json({ error: 'claim failed' }, { status: 503 });
  }

  if (!claimed) return Response.json({ ok: true, duplicate: true });

  // Comments take their own path: most of them are not leads, and one that is
  // needs a private reply rather than a DM. Nothing is written until the intent
  // check has passed, so a post with 47 comments does not create 47 conversations.
  if (event.type === 'comment') {
    after(async () => {
      try {
        await handleCommentEvent(event);
      } catch (commentError) {
        console.error('[webhook] comment capture failed', commentError);
        await logEvent(null, 'comment.processing_failed', {
          commentId: event.commentId,
          providerAccountId: event.providerAccountId,
          message: commentError instanceof Error ? commentError.message : String(commentError),
        });
      }
    });

    return Response.json({ ok: true, kind: 'comment' });
  }

  try {
    const ingested = await ingestInboundEvent(event);
    if (!ingested) return Response.json({ ok: true, unmapped: true });

    after(async () => {
      try {
        await runShopperTurn({
          merchantId: ingested.merchantId,
          conversationId: ingested.conversationId,
          customerId: ingested.customerId,
        });
      } catch (agentError) {
        // The message is already saved, so nothing is lost — the merchant sees the
        // conversation, and the health view sees why the agent did not answer.
        console.error('[webhook] agent turn failed', agentError);
        await logEvent(ingested.merchantId, 'agent.turn_failed', {
          conversationId: ingested.conversationId,
          message: agentError instanceof Error ? agentError.message : String(agentError),
        });
      }
    });

    return Response.json({ ok: true });
  } catch (error) {
    console.error('[webhook] failed to ingest inbound event', error);
    await logEvent(null, 'inbound.ingest_failed', {
      eventId: event.eventId,
      providerAccountId: event.providerAccountId,
      message: error instanceof Error ? error.message : String(error),
    });
    // Release so the provider's retry is not swallowed as a duplicate.
    await releaseEvent(event.eventId);
    return Response.json({ error: 'ingest failed' }, { status: 500 });
  }
}
