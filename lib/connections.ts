import { supabaseAdmin } from './supabase/admin';
import { encryptCredentials } from './crypto';
import { logEvent } from './log';
import { verifyShopifyConnection } from './shopify/client';

/**
 * Connecting a merchant's accounts. Credentials are verified against the live API
 * before they are stored — a token that does not work should fail in front of the
 * merchant during onboarding, not silently in a cron job at 3am.
 */

export async function connectShopify(params: {
  merchantId: string;
  shopDomain: string;
  accessToken: string;
}): Promise<{ shopName: string; currencyCode: string }> {
  // Merchants paste anything from "boutique" to a full admin URL.
  const shopDomain = normaliseShopDomain(params.shopDomain);
  const accessToken = params.accessToken.trim();

  const shop = await verifyShopifyConnection({ shopDomain, accessToken });

  const { error } = await supabaseAdmin()
    .from('connections')
    .upsert(
      {
        merchant_id: params.merchantId,
        kind: 'shopify',
        provider_account_id: shopDomain,
        credentials: encryptCredentials({ shopDomain, accessToken }),
        status: 'active',
      },
      { onConflict: 'merchant_id,kind' }
    );

  if (error) throw error;

  await logEvent(params.merchantId, 'connection.shopify_connected', { shopDomain, shopName: shop.name });
  return { shopName: shop.name, currencyCode: shop.currencyCode };
}

/**
 * Records the merchant's Instagram account id against them. The account itself is
 * connected through the provider's OAuth flow; this is the mapping that lets an
 * inbound webhook find the right merchant.
 */
export async function connectInstagram(params: {
  merchantId: string;
  providerAccountId: string;
  handle?: string | null;
}): Promise<void> {
  const { error } = await supabaseAdmin()
    .from('connections')
    .upsert(
      {
        merchant_id: params.merchantId,
        kind: 'instagram',
        provider_account_id: params.providerAccountId,
        credentials: params.handle ? encryptCredentials({ handle: params.handle }) : {},
        status: 'active',
      },
      { onConflict: 'merchant_id,kind' }
    );

  if (error) throw error;
  await logEvent(params.merchantId, 'connection.instagram_connected', {
    providerAccountId: params.providerAccountId,
  });
}

export async function getConnections(merchantId: string) {
  const { data } = await supabaseAdmin()
    .from('connections')
    .select('kind, provider_account_id, status, created_at')
    .eq('merchant_id', merchantId);

  return data ?? [];
}

/** Accepts "boutique", "boutique.myshopify.com", or a pasted admin URL. */
export function normaliseShopDomain(input: string): string {
  let value = input.trim().toLowerCase();
  value = value.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!value) throw new Error('Enter your Shopify store address');
  if (!value.includes('.')) value = `${value}.myshopify.com`;
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(value)) {
    throw new Error(`"${input}" is not a Shopify store address — it should look like boutique.myshopify.com`);
  }
  return value;
}
