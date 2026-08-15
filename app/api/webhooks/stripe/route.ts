import { stripe, merchantForStripeAccount } from '@/lib/stripe/client';
import { recordPaidCheckout, markLinkExpired } from '@/lib/stripe/checkout';
import { env } from '@/lib/env';
import { logEvent } from '@/lib/log';

/**
 * Stripe webhook → `attributed_sales` (§4.7 step 5).
 *
 * This is where the product proves itself. A merchant who can see a dollar figure
 * in week one and trace it to the conversation that produced it does not need to
 * understand anything about AI (§1.4).
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const signature = req.headers.get('stripe-signature');
  if (!signature) return Response.json({ error: 'missing signature' }, { status: 400 });

  // Signature is verified against the raw bytes, before anything is trusted.
  const rawBody = await req.text();

  let event;
  try {
    event = await stripe().webhooks.constructEventAsync(
      rawBody,
      signature,
      env.stripeWebhookSecret()
    );
  } catch (error) {
    console.error('[stripe] signature verification failed', error);
    return Response.json({ error: 'invalid signature' }, { status: 400 });
  }

  // Connected-account events carry the account they happened on. Without it we
  // cannot tell whose sale this is, and attributing to the wrong merchant is worse
  // than not attributing at all.
  const accountId = event.account;
  if (!accountId) return Response.json({ ok: true, ignored: 'platform_event' });

  const merchantId = await merchantForStripeAccount(accountId);
  if (!merchantId) {
    await logEvent(null, 'stripe.unmapped_account', { accountId, type: event.type });
    return Response.json({ ok: true, ignored: 'unmapped_account' });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object;
        // A session can complete before the payment settles — bank debits, for
        // instance. Only a paid session is a sale.
        if (session.payment_status !== 'paid') {
          return Response.json({ ok: true, ignored: 'not_yet_paid' });
        }

        const result = await recordPaidCheckout({
          sessionId: session.id,
          amountCents: session.amount_total ?? 0,
          merchantId,
          customerEmail: session.customer_details?.email ?? null,
        });

        return Response.json({ ok: true, ...result });
      }

      case 'checkout.session.expired': {
        const session = event.data.object;
        await markLinkExpired(session.id, merchantId);
        return Response.json({ ok: true, expired: true });
      }

      default:
        return Response.json({ ok: true, ignored: event.type });
    }
  } catch (error) {
    console.error('[stripe] failed to process event', error);
    await logEvent(merchantId, 'stripe.processing_failed', {
      type: event.type,
      message: error instanceof Error ? error.message : String(error),
    });
    // Ask Stripe to retry rather than losing a sale record.
    return Response.json({ error: 'processing failed' }, { status: 500 });
  }
}
