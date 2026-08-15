import Stripe from 'stripe';
import { supabaseAdmin } from '../supabase/admin';
import { decryptCredentials } from '../crypto';
import { env } from '../env';

/**
 * Stripe Connect (BUILD_SPEC §4.7 step 5).
 *
 * Charges are made *on the merchant's own connected account*, so the money goes
 * straight to them and we never touch it. That is not a technical convenience —
 * we are a service they hire, not a payment processor, and a platform holding
 * funds is a different business with different obligations.
 */

let cached: Stripe | null = null;

export function stripe(): Stripe {
  if (!cached) {
    // Pinned to the version this code was written against. Letting Stripe pick
    // means a silent API change lands in a payment path with no deploy.
    cached = new Stripe(env.stripeSecretKey(), { apiVersion: '2026-07-29.dahlia' });
  }
  return cached;
}

/** The merchant's connected account id, or null if they have not connected Stripe. */
export async function getStripeAccountId(merchantId: string): Promise<string | null> {
  const { data } = await supabaseAdmin()
    .from('connections')
    .select('provider_account_id, status')
    .eq('merchant_id', merchantId)
    .eq('kind', 'stripe')
    .eq('status', 'active')
    .maybeSingle();

  return data?.provider_account_id ?? null;
}

/** Reverse lookup for webhook routing: connected account id -> merchant. */
export async function merchantForStripeAccount(accountId: string): Promise<string | null> {
  const { data } = await supabaseAdmin()
    .from('connections')
    .select('merchant_id')
    .eq('kind', 'stripe')
    .eq('provider_account_id', accountId)
    .maybeSingle();

  return data?.merchant_id ?? null;
}

/**
 * Standard Connect via OAuth: the merchant links the Stripe account they already
 * have, keeping their existing payouts, tax setup and dashboard. Express would
 * mean onboarding them into an account we administer, which is more surface than
 * a boutique with a working Stripe account needs.
 */
export function stripeConnectUrl(state: string, redirectUri: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: env.stripeConnectClientId(),
    scope: 'read_write',
    redirect_uri: redirectUri,
    state,
  });
  return `https://connect.stripe.com/oauth/authorize?${params.toString()}`;
}

export async function exchangeStripeOAuthCode(code: string): Promise<string> {
  const response = await stripe().oauth.token({ grant_type: 'authorization_code', code });
  if (!response.stripe_user_id) throw new Error('Stripe did not return a connected account id');
  return response.stripe_user_id;
}

/** Unused today — kept so the shape is obvious if we ever store per-merchant keys. */
export async function decryptStripeCredentials(
  credentials: Record<string, string> | null
): Promise<Record<string, string>> {
  return credentials ? decryptCredentials(credentials) : {};
}
