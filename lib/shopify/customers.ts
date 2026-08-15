import { supabaseAdmin } from '../supabase/admin';
import { logEvent } from '../log';
import { getShopifyCredentials, shopifyGraphQL, ShopifyError } from './client';
import { extractHandle, joinCustomers, normaliseHandle } from '../identity';

/**
 * Seeding customers from past Shopify orders (§4.14).
 *
 * This is what makes "she knows all 3,000 of them" true on day one rather than in
 * month six. Each order tells us a name, an email, what they bought and what they
 * spent — and, often enough to matter, the Instagram handle the merchant typed into
 * the order note when she sold to them in DMs.
 *
 * Read-only, and strictly her own first-party data. Nothing here touches a
 * non-authorising user's profile (§3.8).
 */

const ORDERS_QUERY = `
  query SeedCustomers($cursor: String) {
    orders(first: 50, after: $cursor, sortKey: CREATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        createdAt
        note
        customAttributes { key value }
        totalPriceSet { shopMoney { amount } }
        customer { id email displayName tags note }
        lineItems(first: 20) { nodes { title variantTitle } }
      }
    }
  }
`;

interface OrdersPage {
  orders: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{
      id: string;
      createdAt: string;
      note: string | null;
      customAttributes: Array<{ key: string; value: string | null }>;
      totalPriceSet: { shopMoney: { amount: string } };
      customer: {
        id: string;
        email: string | null;
        displayName: string | null;
        tags: string[];
        note: string | null;
      } | null;
      lineItems: { nodes: Array<{ title: string; variantTitle: string | null }> };
    }>;
  };
}

export interface SeedResult {
  ordersRead: number;
  customersSeeded: number;
  /** Joined straight to an Instagram shopper because the handle was in Shopify. */
  handlesMatched: number;
}

/** Deep enough to be useful, shallow enough to finish inside onboarding. */
const MAX_PAGES = 8;

export async function seedCustomersFromOrders(merchantId: string): Promise<SeedResult> {
  const credentials = await getShopifyCredentials(merchantId);
  if (!credentials) throw new ShopifyError('No active Shopify connection');

  const db = supabaseAdmin();
  const result: SeedResult = { ordersRead: 0, customersSeeded: 0, handlesMatched: 0 };

  // One record per Shopify customer, with their orders folded together.
  const byCustomer = new Map<
    string,
    {
      email: string | null;
      name: string | null;
      handle: string | null;
      spentCents: number;
      lastOrderAt: string;
      bought: string[];
    }
  >();

  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data: OrdersPage = await shopifyGraphQL<OrdersPage>(credentials, ORDERS_QUERY, { cursor });

    for (const order of data.orders.nodes) {
      result.ordersRead += 1;
      if (!order.customer) continue;

      const existing = byCustomer.get(order.customer.id);

      // Tier 1: the merchant already wrote the handle down when she sold to them.
      const handle =
        existing?.handle ??
        extractHandle(
          order.note,
          order.customer.note,
          order.customer.tags?.join(' '),
          ...order.customAttributes.map((attribute) => `${attribute.key} ${attribute.value ?? ''}`)
        );

      const amountCents = Math.round(Number.parseFloat(order.totalPriceSet.shopMoney.amount) * 100);
      const items = order.lineItems.nodes.map((item) =>
        [item.title, item.variantTitle].filter(Boolean).join(' — ')
      );

      byCustomer.set(order.customer.id, {
        email: order.customer.email ?? existing?.email ?? null,
        name: order.customer.displayName ?? existing?.name ?? null,
        handle,
        spentCents: (existing?.spentCents ?? 0) + (Number.isFinite(amountCents) ? amountCents : 0),
        lastOrderAt: existing?.lastOrderAt ?? order.createdAt,
        bought: [...(existing?.bought ?? []), ...items].slice(0, 20),
      });
    }

    if (!data.orders.pageInfo.hasNextPage) break;
    cursor = data.orders.pageInfo.endCursor;
  }

  for (const [shopifyCustomerId, customer] of byCustomer) {
    // A handle found in Shopify may already exist as an Instagram shopper. If so
    // the history attaches to them rather than creating a second record.
    const existingInstagram = customer.handle
      ? await findByHandle(merchantId, customer.handle)
      : null;

    if (existingInstagram) {
      await db
        .from('customers')
        .update({
          email: customer.email,
          shopify_customer_id: shopifyCustomerId,
          lifetime_value_cents: customer.spentCents,
          preferences: { bought: customer.bought.slice(0, 10) },
        })
        .eq('id', existingInstagram);

      result.handlesMatched += 1;
      continue;
    }

    const { error } = await db.from('customers').upsert(
      {
        merchant_id: merchantId,
        platform_user_id: null,
        handle: customer.handle,
        name: customer.name,
        email: customer.email,
        shopify_customer_id: shopifyCustomerId,
        lifetime_value_cents: customer.spentCents,
        last_seen_at: customer.lastOrderAt,
        first_seen_source: 'shopify',
        preferences: { bought: customer.bought.slice(0, 10) },
      },
      { onConflict: 'merchant_id,shopify_customer_id' }
    );

    if (!error) result.customersSeeded += 1;
  }

  await logEvent(merchantId, 'shopify.customers_seeded', { ...result });
  return result;
}

async function findByHandle(merchantId: string, handle: string): Promise<string | null> {
  const { data } = await supabaseAdmin()
    .from('customers')
    .select('id')
    .eq('merchant_id', merchantId)
    .not('platform_user_id', 'is', null)
    .ilike('handle', normaliseHandle(handle))
    .maybeSingle();

  return data?.id ?? null;
}

/**
 * A new Instagram shopper may be someone Shopify already knows, if the merchant
 * wrote their handle on an old order. Checked once, when we first meet them.
 */
export async function joinNewShopperByHandle(params: {
  merchantId: string;
  customerId: string;
  handle: string | null;
}): Promise<boolean> {
  if (!params.handle) return false;

  const { data: seeded } = await supabaseAdmin()
    .from('customers')
    .select('id')
    .eq('merchant_id', params.merchantId)
    .eq('first_seen_source', 'shopify')
    .is('platform_user_id', null)
    .ilike('handle', normaliseHandle(params.handle))
    .maybeSingle();

  if (!seeded) return false;

  return joinCustomers({
    merchantId: params.merchantId,
    instagramCustomerId: params.customerId,
    shopifyCustomerId: seeded.id,
    reason: 'handle_in_shopify',
  });
}
