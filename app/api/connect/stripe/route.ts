import { redirect } from 'next/navigation';
import { currentMerchant } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { stripeConnectUrl, exchangeStripeOAuthCode } from '@/lib/stripe/client';
import { signState, verifyState } from '@/lib/stripe/oauth-state';
import { logEvent } from '@/lib/log';

/**
 * Stripe Connect OAuth, both legs on one route.
 *
 * The `state` parameter is signed rather than stored: it carries the merchant id
 * and an HMAC over it, so the callback can prove the merchant who came back is
 * the one who left. Without that, anyone who can reach the callback could attach
 * their own Stripe account to someone else's merchant — and then take their money.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATE_TTL_MS = 15 * 60 * 1000;

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error_description') ?? url.searchParams.get('error');
  const redirectUri = `${url.origin}/api/connect/stripe`;

  if (error) {
    redirect(`/settings/connections?error=${encodeURIComponent(error)}`);
  }

  // Leg 2: Stripe sent the merchant back.
  if (code && state) {
    const merchantId = verifyState(state);
    if (!merchantId) {
      redirect('/settings/connections?error=' + encodeURIComponent('That link expired. Try connecting again.'));
    }

    try {
      const accountId = await exchangeStripeOAuthCode(code);

      const { error: saveError } = await supabaseAdmin()
        .from('connections')
        .upsert(
          {
            merchant_id: merchantId,
            kind: 'stripe',
            provider_account_id: accountId,
            credentials: {},
            status: 'active',
          },
          { onConflict: 'merchant_id,kind' }
        );

      if (saveError) throw saveError;

      await logEvent(merchantId, 'connection.stripe_connected', { accountId });
      redirect('/settings/connections?connected=' + encodeURIComponent('Stripe'));
    } catch (exchangeError) {
      if (exchangeError && typeof exchangeError === 'object' && 'digest' in exchangeError) throw exchangeError;
      const message = exchangeError instanceof Error ? exchangeError.message : 'Could not connect Stripe';
      redirect(`/settings/connections?error=${encodeURIComponent(message)}`);
    }
  }

  // Leg 1: send the merchant to Stripe.
  const merchant = await currentMerchant();
  if (!merchant) redirect('/login');

  redirect(stripeConnectUrl(signState(merchant.id), redirectUri));
}
