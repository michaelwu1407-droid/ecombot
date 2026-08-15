import { supabaseAdmin } from '../supabase/admin';
import { logEvent } from '../log';
import { stripe, getStripeAccountId } from './client';

/**
 * Checkout in conversation (BUILD_SPEC §2.2): a payment link generated at detected
 * purchase intent, so the sale closes in the DM rather than in an abandoned
 * browser tab.
 *
 * **Deviation from §4.3, deliberate.** The spec names the column
 * `stripe_payment_link_id`, which implies Stripe's Payment Links API. We use a
 * Checkout Session instead, and store its id in that column. Two reasons:
 *
 *   1. Payment Links require a pre-existing Price object, so quoting one live
 *      means create Product, create Price, create Link — three round trips inside
 *      a five-second budget, and a merchant's Stripe catalogue slowly filling with
 *      throwaway products. Checkout Sessions take inline `price_data`: one call,
 *      exact catalogue price, nothing left behind.
 *   2. Sessions expire, which suits a DM sale. An immortal link is a price quote
 *      that outlives the stock behind it.
 *
 * Both produce a URL the shopper taps, and both report through the same webhook.
 */

/** Long enough to decide, short enough that the price still means something. */
const LINK_LIFETIME_HOURS = 48;

export interface CheckoutLineItem {
  variantId: string;
  quantity: number;
}

export type CheckoutResult =
  | { created: true; url: string; amountCents: number; paymentLinkId: string; currency: string }
  | { created: false; error: string; detail?: string };

export async function createCheckoutLink(params: {
  merchantId: string;
  conversationId: string;
  items: CheckoutLineItem[];
}): Promise<CheckoutResult> {
  const db = supabaseAdmin();

  const accountId = await getStripeAccountId(params.merchantId);
  if (!accountId) return { created: false, error: 'stripe_not_connected' };

  if (!params.items.length) return { created: false, error: 'no_items' };

  // Price and availability come from our synced catalogue, never from the model.
  // A link is a commitment to sell at a number, so the number has to be the real one.
  const variantIds = [...new Set(params.items.map((item) => item.variantId))];
  const { data: products, error } = await db
    .from('products')
    .select('shopify_variant_id, title, variant_title, price_cents, currency, available, image_url')
    .eq('merchant_id', params.merchantId)
    .in('shopify_variant_id', variantIds);

  if (error) throw error;

  const byVariant = new Map((products ?? []).map((product) => [product.shopify_variant_id, product]));

  const missing = variantIds.filter((id) => !byVariant.has(id));
  if (missing.length) return { created: false, error: 'unknown_variant', detail: missing.join(', ') };

  const unavailable = variantIds.filter((id) => !byVariant.get(id)!.available);
  if (unavailable.length) {
    return {
      created: false,
      error: 'out_of_stock',
      detail: unavailable.map((id) => byVariant.get(id)!.title).join(', '),
    };
  }

  // A Stripe session is single-currency. Catching a mixed basket here gives the
  // agent something it can act on, instead of an opaque Stripe error mid-sale.
  const currencies = new Set(variantIds.map((id) => (byVariant.get(id)!.currency || 'USD').toUpperCase()));
  if (currencies.size > 1) {
    return { created: false, error: 'mixed_currencies', detail: [...currencies].join(', ') };
  }

  const currency = [...currencies][0].toLowerCase();

  const lineItems = params.items.map((item) => {
    const product = byVariant.get(item.variantId)!;
    const quantity = Math.max(1, Math.min(20, Math.round(item.quantity || 1)));

    return {
      quantity,
      price_data: {
        currency,
        unit_amount: product.price_cents,
        product_data: {
          name: [product.title, product.variant_title].filter(Boolean).join(' — '),
          images: product.image_url ? [product.image_url] : undefined,
        },
      },
    };
  });

  const amountCents = params.items.reduce((total, item) => {
    const product = byVariant.get(item.variantId)!;
    const quantity = Math.max(1, Math.min(20, Math.round(item.quantity || 1)));
    return total + product.price_cents * quantity;
  }, 0);

  const session = await stripe().checkout.sessions.create(
    {
      mode: 'payment',
      line_items: lineItems,
      expires_at: Math.floor(Date.now() / 1000) + LINK_LIFETIME_HOURS * 3600,
      // Attribution rides on the session, so the webhook can trace the sale back
      // to the conversation without guessing (§2.7).
      metadata: {
        merchant_id: params.merchantId,
        conversation_id: params.conversationId,
      },
    },
    // Direct charge on the merchant's own account. We never hold the funds.
    { stripeAccount: accountId }
  );

  if (!session.url) return { created: false, error: 'stripe_returned_no_url' };

  const { data: record, error: insertError } = await db
    .from('payment_links')
    .insert({
      merchant_id: params.merchantId,
      conversation_id: params.conversationId,
      stripe_payment_link_id: session.id,
      url: session.url,
      amount_cents: amountCents,
      line_items: params.items,
      status: 'created',
    })
    .select('id')
    .single();

  if (insertError) throw insertError;

  await logEvent(params.merchantId, 'payment_link.created', {
    conversationId: params.conversationId,
    amountCents,
    paymentLinkId: record.id,
  });

  return {
    created: true,
    url: session.url,
    amountCents,
    paymentLinkId: record.id,
    currency: currency.toUpperCase(),
  };
}

/**
 * Records a paid link and attributes the sale.
 *
 * Attribution credits the source the *conversation* started from — a comment, a
 * story reply, a revival — which is what lets a merchant trace a sale back to the
 * post that earned it (§4.9). Idempotent: Stripe delivers webhooks more than once.
 */
export async function recordPaidCheckout(params: {
  sessionId: string;
  amountCents: number;
  merchantId: string;
}): Promise<{ attributed: boolean; reason?: string }> {
  const db = supabaseAdmin();

  const { data: link } = await db
    .from('payment_links')
    .select('id, merchant_id, conversation_id, status, amount_cents')
    .eq('stripe_payment_link_id', params.sessionId)
    .maybeSingle();

  if (!link) return { attributed: false, reason: 'unknown_session' };
  if (link.merchant_id !== params.merchantId) return { attributed: false, reason: 'merchant_mismatch' };
  if (link.status === 'paid') return { attributed: false, reason: 'already_recorded' };

  await db
    .from('payment_links')
    .update({ status: 'paid', paid_at: new Date().toISOString() })
    .eq('id', link.id);

  // A link with no conversation is still a sale worth recording — it just cannot
  // be traced to a source. Querying with an empty string would fail outright,
  // because the column is a uuid.
  const { data: conversation } = link.conversation_id
    ? await db
        .from('conversations')
        .select('id, source, customer_id')
        .eq('id', link.conversation_id)
        .maybeSingle()
    : { data: null };

  // The unique index on payment_link_id makes a duplicate webhook a no-op rather
  // than a double-counted sale.
  const { error: saleError } = await db.from('attributed_sales').insert({
    merchant_id: link.merchant_id,
    payment_link_id: link.id,
    conversation_id: link.conversation_id,
    amount_cents: params.amountCents || link.amount_cents,
    source: conversation?.source ?? 'dm',
  });

  if (saleError && saleError.code !== '23505') throw saleError;

  if (conversation) {
    await db
      .from('conversations')
      .update({ outcome: 'sale', status: 'closed' })
      .eq('id', conversation.id);

    // Lifetime value is what makes a returning shopper feel known (§2.4).
    if (conversation.customer_id) {
      const { data: customer } = await db
        .from('customers')
        .select('lifetime_value_cents')
        .eq('id', conversation.customer_id)
        .maybeSingle();

      if (customer) {
        await db
          .from('customers')
          .update({
            lifetime_value_cents:
              (customer.lifetime_value_cents ?? 0) + (params.amountCents || link.amount_cents),
          })
          .eq('id', conversation.customer_id);
      }
    }
  }

  await logEvent(link.merchant_id, 'sale.attributed', {
    conversationId: link.conversation_id,
    amountCents: params.amountCents || link.amount_cents,
    source: conversation?.source ?? 'dm',
  });

  return { attributed: true };
}

/** A session the shopper never completed before it timed out. */
export async function markLinkExpired(sessionId: string, merchantId: string): Promise<void> {
  await supabaseAdmin()
    .from('payment_links')
    .update({ status: 'expired' })
    .eq('stripe_payment_link_id', sessionId)
    .eq('merchant_id', merchantId)
    .eq('status', 'created');
}
