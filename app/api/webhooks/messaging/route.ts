import { after } from 'next/server';
import { getMessagingProvider } from '@/lib/messaging';
import { runShopperTurn } from '@/lib/agent/run';
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
