import { supabaseAdmin } from '../supabase/admin';
import { decryptCredentials } from '../crypto';

/**
 * Shopify Admin API client.
 *
 * One commerce integration, deliberately (§3.5). Integration sprawl is where
 * engineering time disappears, and saying no here is the highest-leverage
 * discipline in the build.
 *
 * Plain fetch against the GraphQL Admin API — no SDK. The stack list (§4.1) does
 * not include one, and the surface we use is two queries wide.
 */

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';

export interface ShopifyCredentials {
  shopDomain: string; // e.g. boutique.myshopify.com
  accessToken: string; // custom app admin token, shpat_...
}

export class ShopifyError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable = false) {
    super(message);
    this.name = 'ShopifyError';
    this.retryable = retryable;
  }
}

/** Decrypts the merchant's stored Shopify credentials, or null if not connected. */
export async function getShopifyCredentials(merchantId: string): Promise<ShopifyCredentials | null> {
  const { data } = await supabaseAdmin()
    .from('connections')
    .select('credentials, status')
    .eq('merchant_id', merchantId)
    .eq('kind', 'shopify')
    .eq('status', 'active')
    .maybeSingle();

  if (!data?.credentials) return null;

  const decrypted = decryptCredentials(data.credentials as Record<string, string>);
  if (!decrypted.shopDomain || !decrypted.accessToken) return null;

  return { shopDomain: decrypted.shopDomain, accessToken: decrypted.accessToken };
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
}

export async function shopifyGraphQL<T>(
  credentials: ShopifyCredentials,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  const response = await fetch(
    `https://${credentials.shopDomain}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': credentials.accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20_000),
    }
  );

  if (response.status === 401 || response.status === 403) {
    throw new ShopifyError('Shopify rejected the access token — the connection needs reauthorising');
  }
  if (response.status === 429 || response.status >= 500) {
    throw new ShopifyError(`Shopify returned ${response.status}`, true);
  }
  if (!response.ok) {
    throw new ShopifyError(`Shopify returned ${response.status}`);
  }

  const body = (await response.json()) as GraphQLResponse<T>;

  if (body.errors?.length) {
    // Shopify's GraphQL API is cost-throttled; THROTTLED means slow down, not fail.
    const throttled = body.errors.some((e) => e.extensions?.code === 'THROTTLED');
    throw new ShopifyError(body.errors.map((e) => e.message).join('; '), throttled);
  }

  if (!body.data) throw new ShopifyError('Shopify returned no data');
  return body.data;
}

/**
 * Confirms the token works and returns the shop's name and currency.
 * Called at connect time so a bad token fails in front of the merchant rather
 * than silently at 3am in a cron job.
 */
export async function verifyShopifyConnection(
  credentials: ShopifyCredentials
): Promise<{ name: string; currencyCode: string }> {
  const data = await shopifyGraphQL<{ shop: { name: string; currencyCode: string } }>(
    credentials,
    `query { shop { name currencyCode } }`
  );
  return data.shop;
}

/** Shopify money strings are decimal ("45.00"); we store integer cents throughout. */
export function toCents(amount: string): number {
  return Math.round(Number.parseFloat(amount) * 100);
}
