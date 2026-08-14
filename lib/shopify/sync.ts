import { supabaseAdmin } from '../supabase/admin';
import { logEvent } from '../log';
import {
  getShopifyCredentials,
  shopifyGraphQL,
  toCents,
  ShopifyError,
  type ShopifyCredentials,
} from './client';

/**
 * Pulls the merchant's catalogue into `products` (§4.7 step 2).
 *
 * Everything the shopper agent says about price and stock is grounded in this
 * table, so a stale row is a wrong answer in front of a customer — the failure
 * mode §1.4 says never to accept. The sync runs hourly and is the reason the
 * agent can answer in under five seconds without calling Shopify mid-conversation.
 */

const PRODUCTS_PER_PAGE = 50;
const VARIANTS_PER_PRODUCT = 100;

const PRODUCTS_QUERY = `
  query SyncProducts($cursor: String, $productLimit: Int!, $variantLimit: Int!) {
    shop { currencyCode }
    products(first: $productLimit, after: $cursor, query: "status:active") {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        featuredImage { url }
        variants(first: $variantLimit) {
          nodes {
            id
            title
            price
            availableForSale
            inventoryQuantity
            image { url }
          }
        }
      }
    }
  }
`;

interface ProductsPage {
  shop: { currencyCode: string };
  products: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{
      id: string;
      title: string;
      featuredImage: { url: string } | null;
      variants: {
        nodes: Array<{
          id: string;
          title: string | null;
          price: string;
          availableForSale: boolean;
          inventoryQuantity: number | null;
          image: { url: string } | null;
        }>;
      };
    }>;
  };
}

export interface SyncResult {
  productsSeen: number;
  variantsUpserted: number;
  variantsRetired: number;
}

export async function syncProducts(merchantId: string): Promise<SyncResult> {
  const credentials = await getShopifyCredentials(merchantId);
  if (!credentials) {
    throw new ShopifyError(`Merchant ${merchantId} has no active Shopify connection`);
  }

  const startedAt = new Date();
  const rows = await fetchAllVariants(merchantId, credentials);

  const db = supabaseAdmin();
  let variantsUpserted = 0;

  // Chunked so one oversized catalogue does not exceed the request limit.
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await db
      .from('products')
      .upsert(chunk, { onConflict: 'merchant_id,shopify_variant_id' });
    if (error) throw error;
    variantsUpserted += chunk.length;
  }

  // A variant that vanished from Shopify — deleted, archived, or unpublished —
  // must stop being sellable here too. Marked unavailable rather than deleted, so
  // waitlist entries and past conversations keep their references.
  const { data: retired, error: retireError } = await db
    .from('products')
    .update({ available: false, inventory_quantity: 0 })
    .eq('merchant_id', merchantId)
    .lt('last_synced_at', startedAt.toISOString())
    .eq('available', true)
    .select('id');

  if (retireError) throw retireError;

  const result: SyncResult = {
    productsSeen: new Set(rows.map((r) => r.shopify_product_id)).size,
    variantsUpserted,
    variantsRetired: retired?.length ?? 0,
  };

  await logEvent(merchantId, 'shopify.sync_completed', { ...result });
  return result;
}

async function fetchAllVariants(merchantId: string, credentials: ShopifyCredentials) {
  const rows: Array<{
    merchant_id: string;
    shopify_product_id: string;
    shopify_variant_id: string;
    title: string;
    variant_title: string | null;
    price_cents: number;
    currency: string;
    inventory_quantity: number;
    image_url: string | null;
    available: boolean;
    last_synced_at: string;
  }> = [];

  let cursor: string | null = null;
  let currency = 'USD';

  // Bounded so a pagination bug cannot loop forever against a merchant's store.
  for (let page = 0; page < 200; page += 1) {
    const data: ProductsPage = await withRetry(() =>
      shopifyGraphQL<ProductsPage>(credentials, PRODUCTS_QUERY, {
        cursor,
        productLimit: PRODUCTS_PER_PAGE,
        variantLimit: VARIANTS_PER_PRODUCT,
      })
    );

    currency = data.shop.currencyCode || currency;
    const syncedAt = new Date().toISOString();

    for (const product of data.products.nodes) {
      for (const variant of product.variants.nodes) {
        const quantity = variant.inventoryQuantity ?? 0;
        rows.push({
          merchant_id: merchantId,
          shopify_product_id: product.id,
          shopify_variant_id: variant.id,
          title: product.title,
          variant_title: variant.title,
          price_cents: toCents(variant.price),
          currency,
          inventory_quantity: quantity,
          image_url: variant.image?.url ?? product.featuredImage?.url ?? null,
          // Trust Shopify's own sellability flag over the raw count: a merchant
          // who oversells deliberately has availableForSale true at zero stock,
          // and second-guessing that would make the agent refuse real sales.
          available: variant.availableForSale,
          last_synced_at: syncedAt,
        });
      }
    }

    if (!data.products.pageInfo.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor;
  }

  return rows;
}

/** Shopify's GraphQL API is cost-throttled. Backs off rather than dropping the sync. */
async function withRetry<T>(operation: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const retryable = error instanceof ShopifyError && error.retryable;
      if (!retryable || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }

  throw lastError;
}
