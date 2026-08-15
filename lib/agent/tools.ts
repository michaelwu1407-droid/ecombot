import { supabaseAdmin } from '../supabase/admin';
import { logEvent } from '../log';
import { getShopifyCredentials, shopifyGraphQL } from '../shopify/client';
import { createCheckoutLink } from '../stripe/checkout';
import type { Tool, ToolContext, ToolDefinition } from './types';

/**
 * The shopper agent's tools (BUILD_SPEC §4.4).
 *
 * Two rules hold for every one of them:
 *
 *   * **Structured data, never prose.** The tool supplies facts; the model writes
 *     the sentence. A tool that returned "we have 3 left in a size 10" would put
 *     the model's phrasing beyond the reach of the guardrails.
 *
 *   * **Scoped to the calling merchant, from context and never from arguments.**
 *     The model is steered by public, untrusted input. Where the spec's signature
 *     takes a `customerId`, the argument is accepted and then ignored in favour of
 *     the conversation's own customer — otherwise a shopper who talks the model
 *     into passing a different id reads someone else's purchase history.
 */

const MAX_SEARCH_RESULTS = 5;

// ---------------------------------------------------------------------------
// search_products
// ---------------------------------------------------------------------------

const searchProducts: Tool = {
  definition: {
    name: 'search_products',
    description:
      "Search the shop's catalogue. Use this before saying anything about what is available, what it costs, or what sizes exist.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the shopper is asking about, e.g. "linen dress"' },
        size: { type: 'string', description: 'Size, if they named one, e.g. "10" or "M"' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },

  async handler(args, context) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const size = typeof args.size === 'string' ? args.size.trim() : null;
    if (!query) return { error: 'query is required' };

    const db = supabaseAdmin();
    let builder = db
      .from('products')
      .select('shopify_variant_id, title, variant_title, price_cents, currency, inventory_quantity, available, image_url')
      .eq('merchant_id', context.merchantId);

    // Match any word the shopper used, so "linen dress" finds "Linen Midi Dress".
    const terms = query
      .split(/\s+/)
      .map(escapeSearchTerm)
      .filter((term) => term.length > 1)
      .slice(0, 5);

    // With no usable terms, an unfiltered query would return five arbitrary
    // products and the agent would quote a price for something nobody asked about.
    if (!terms.length) return { results: [], count: 0 };

    builder = builder.or(terms.map((term) => `title.ilike.%${term}%`).join(','));
    if (size) {
      builder = builder.ilike('variant_title', `%${size}%`);
    }

    // In-stock first: a shopper asking "do you have this" wants what they can buy.
    const { data, error } = await builder
      .order('available', { ascending: false })
      .order('inventory_quantity', { ascending: false })
      .limit(MAX_SEARCH_RESULTS);

    if (error) throw error;

    const results = (data ?? []).map((row) => {
      context.ledger.pricesCents.add(row.price_cents);
      if (row.available) context.ledger.availableVariantIds.add(row.shopify_variant_id);
      else context.ledger.unavailableVariantIds.add(row.shopify_variant_id);

      return {
        variantId: row.shopify_variant_id,
        title: row.title,
        size: row.variant_title,
        price: formatMoney(row.price_cents, row.currency),
        priceCents: row.price_cents,
        inStock: row.available,
        quantity: row.inventory_quantity,
        imageUrl: row.image_url,
      };
    });

    return { results, count: results.length };
  },
};

// ---------------------------------------------------------------------------
// check_stock
// ---------------------------------------------------------------------------

const checkStock: Tool = {
  definition: {
    name: 'check_stock',
    description:
      'Check whether one specific variant is in stock. Required before telling a shopper an item is available.',
    parameters: {
      type: 'object',
      properties: {
        variantId: { type: 'string', description: 'variantId from search_products' },
      },
      required: ['variantId'],
      additionalProperties: false,
    },
  },

  async handler(args, context) {
    const variantId = typeof args.variantId === 'string' ? args.variantId : '';
    if (!variantId) return { error: 'variantId is required' };

    const { data, error } = await supabaseAdmin()
      .from('products')
      .select('shopify_variant_id, title, variant_title, price_cents, currency, inventory_quantity, available')
      .eq('merchant_id', context.merchantId)
      .eq('shopify_variant_id', variantId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return { found: false, available: false, quantity: 0 };

    context.ledger.pricesCents.add(data.price_cents);
    if (data.available) context.ledger.availableVariantIds.add(variantId);
    else context.ledger.unavailableVariantIds.add(variantId);

    return {
      found: true,
      available: data.available,
      quantity: data.inventory_quantity,
      title: data.title,
      size: data.variant_title,
      price: formatMoney(data.price_cents, data.currency),
    };
  },
};

// ---------------------------------------------------------------------------
// get_customer_history
// ---------------------------------------------------------------------------

const getCustomerHistory: Tool = {
  definition: {
    name: 'get_customer_history',
    description:
      'What you know about the shopper you are talking to: past purchases, size, preferences.',
    parameters: {
      type: 'object',
      properties: {
        customerId: { type: 'string', description: 'Ignored — always the current shopper' },
      },
      additionalProperties: false,
    },
  },

  async handler(_args, context) {
    // The argument is deliberately ignored. See the note at the top of this file.
    const db = supabaseAdmin();

    const { data: customer } = await db
      .from('customers')
      .select('handle, name, size, preferences, budget_range, lifetime_value_cents, created_at')
      .eq('id', context.customerId)
      .eq('merchant_id', context.merchantId)
      .maybeSingle();

    if (!customer) return { known: false };

    const { data: sales } = await db
      .from('attributed_sales')
      .select('amount_cents, created_at, source')
      .eq('merchant_id', context.merchantId)
      .in(
        'conversation_id',
        (
          await db
            .from('conversations')
            .select('id')
            .eq('merchant_id', context.merchantId)
            .eq('customer_id', context.customerId)
        ).data?.map((row) => row.id) ?? []
      )
      .order('created_at', { ascending: false })
      .limit(10);

    return {
      known: true,
      name: customer.name,
      size: customer.size,
      preferences: customer.preferences,
      budgetRange: customer.budget_range,
      lifetimeValue: formatMoney(customer.lifetime_value_cents, 'USD'),
      customerSince: customer.created_at,
      purchases: (sales ?? []).map((sale) => ({
        amount: formatMoney(sale.amount_cents, 'USD'),
        when: sale.created_at,
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// add_to_waitlist
// ---------------------------------------------------------------------------

const addToWaitlist: Tool = {
  definition: {
    name: 'add_to_waitlist',
    description:
      'Add the shopper to the waitlist for a sold-out variant, so they are told when it returns. Use this instead of ending the conversation on "sold out".',
    parameters: {
      type: 'object',
      properties: {
        variantId: { type: 'string', description: 'variantId from search_products' },
        customerId: { type: 'string', description: 'Ignored — always the current shopper' },
      },
      required: ['variantId'],
      additionalProperties: false,
    },
  },

  async handler(args, context) {
    const variantId = typeof args.variantId === 'string' ? args.variantId : '';
    if (!variantId) return { added: false, error: 'variantId is required' };

    const db = supabaseAdmin();
    const { data: product } = await db
      .from('products')
      .select('id, title, variant_title')
      .eq('merchant_id', context.merchantId)
      .eq('shopify_variant_id', variantId)
      .maybeSingle();

    if (!product) return { added: false, error: 'unknown variant' };

    const { error } = await db.from('waitlist_entries').upsert(
      {
        merchant_id: context.merchantId,
        customer_id: context.customerId,
        product_id: product.id,
        conversation_id: context.conversationId,
        status: 'waiting',
      },
      { onConflict: 'customer_id,product_id', ignoreDuplicates: true }
    );

    if (error) throw error;

    await logEvent(context.merchantId, 'waitlist.added', {
      conversationId: context.conversationId,
      variantId,
    });

    return { added: true, title: product.title, size: product.variant_title };
  },
};

// ---------------------------------------------------------------------------
// check_order_status
// ---------------------------------------------------------------------------

const checkOrderStatus: Tool = {
  definition: {
    name: 'check_order_status',
    description: "Look up an existing order by its number, e.g. #1042.",
    parameters: {
      type: 'object',
      properties: {
        orderReference: { type: 'string', description: 'Order number as the shopper gave it' },
      },
      required: ['orderReference'],
      additionalProperties: false,
    },
  },

  async handler(args, context) {
    const reference = typeof args.orderReference === 'string' ? args.orderReference.trim() : '';
    if (!reference) return { found: false, error: 'orderReference is required' };

    const credentials = await getShopifyCredentials(context.merchantId);
    if (!credentials) return { found: false, error: 'store not connected' };

    const data = await shopifyGraphQL<{
      orders: {
        nodes: Array<{
          name: string;
          displayFulfillmentStatus: string;
          displayFinancialStatus: string;
          createdAt: string;
          fulfillments: Array<{ trackingInfo: Array<{ number: string | null; url: string | null }> }>;
        }>;
      };
    }>(
      credentials,
      `query FindOrder($query: String!) {
        orders(first: 1, query: $query) {
          nodes {
            name
            displayFulfillmentStatus
            displayFinancialStatus
            createdAt
            fulfillments(first: 3) { trackingInfo { number url } }
          }
        }
      }`,
      // Quoted so the shopper's text cannot inject extra search qualifiers.
      { query: `name:"${reference.replace(/[\\"]/g, '')}"` }
    );

    const order = data.orders.nodes[0];
    if (!order) return { found: false };

    const tracking = order.fulfillments.flatMap((f) => f.trackingInfo).filter((t) => t.number);

    return {
      found: true,
      orderNumber: order.name,
      fulfillment: order.displayFulfillmentStatus,
      payment: order.displayFinancialStatus,
      placedAt: order.createdAt,
      tracking: tracking.map((t) => ({ number: t.number, url: t.url })),
    };
  },
};

// ---------------------------------------------------------------------------
// get_policy
// ---------------------------------------------------------------------------

const getPolicy: Tool = {
  definition: {
    name: 'get_policy',
    description:
      "The shop's shipping or returns policy, in the owner's own words. Quote this rather than paraphrasing it.",
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['shipping', 'returns'] },
      },
      required: ['kind'],
      additionalProperties: false,
    },
  },

  async handler(args, context) {
    const kind = args.kind === 'returns' ? 'returns' : args.kind === 'shipping' ? 'shipping' : null;
    if (!kind) return { error: "kind must be 'shipping' or 'returns'" };

    const text = kind === 'shipping' ? context.config.shipping_policy : context.config.returns_policy;

    if (!text) {
      // No policy on file is not an invitation to invent one.
      return { kind, stated: false, guidance: 'No policy on file. Escalate rather than guessing.' };
    }

    context.ledger.policies.set(kind, text);
    return { kind, stated: true, policy: text };
  },
};

// ---------------------------------------------------------------------------
// escalate
// ---------------------------------------------------------------------------

const escalate: Tool = {
  definition: {
    name: 'escalate',
    description:
      'Hand this conversation to the owner. Use for complaints, returns, disputes, delivery problems, anything about health or a reaction to a product, and anything you are not sure about.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why, in one line, for the owner to read' },
      },
      required: ['reason'],
      additionalProperties: false,
    },
  },

  async handler(args, context) {
    const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : 'unspecified';
    context.ledger.escalation = { reason };

    await supabaseAdmin()
      .from('conversations')
      .update({ status: 'escalated' })
      .eq('id', context.conversationId)
      .eq('merchant_id', context.merchantId);

    await logEvent(context.merchantId, 'conversation.escalated', {
      conversationId: context.conversationId,
      reason,
    });

    return {
      escalated: true,
      instruction:
        'Tell the shopper the owner will come back to them personally, shortly. Do not attempt to answer the question yourself.',
    };
  },
};

// ---------------------------------------------------------------------------
// create_payment_link — implemented in stage 5 (Stripe Connect)
// ---------------------------------------------------------------------------

const createPaymentLink: Tool = {
  definition: {
    name: 'create_payment_link',
    description: 'Generate a checkout link when the shopper has decided to buy.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'What they are buying',
          items: {
            type: 'object',
            properties: {
              variantId: { type: 'string' },
              quantity: { type: 'number' },
            },
            required: ['variantId'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
  },

  async handler(args, context) {
    const items = parseCheckoutItems(args.items);
    if (!items.length) {
      return { created: false, error: 'no_items', instruction: 'Call search_products first, then use the variantIds it returned.' };
    }

    const result = await createCheckoutLink({
      merchantId: context.merchantId,
      conversationId: context.conversationId,
      items,
    });

    if (!result.created) {
      // Structured refusals rather than throws, so the model can recover and hand
      // off gracefully instead of the turn dying mid-conversation.
      return { ...result, instruction: checkoutFailureInstruction(result.error) };
    }

    // The total is now tool-established, so the price guardrail will let the agent
    // say it out loud.
    context.ledger.pricesCents.add(result.amountCents);
    context.ledger.paymentLinkUrls.add(result.url);

    return {
      created: true,
      url: result.url,
      total: formatMoney(result.amountCents, result.currency),
      totalCents: result.amountCents,
      instruction: 'Send the link and the total. Do not add any other figures.',
    };
  },
};

function parseCheckoutItems(raw: unknown): Array<{ variantId: string; quantity: number }> {
  if (!Array.isArray(raw)) return [];

  return raw
    .map((entry) => {
      if (typeof entry !== 'object' || entry === null) return null;
      const record = entry as Record<string, unknown>;
      const variantId = typeof record.variantId === 'string' ? record.variantId : null;
      if (!variantId) return null;

      const quantity = typeof record.quantity === 'number' ? record.quantity : 1;
      return { variantId, quantity };
    })
    .filter((item): item is { variantId: string; quantity: number } => item !== null)
    .slice(0, 10);
}

function checkoutFailureInstruction(error: string): string {
  switch (error) {
    case 'stripe_not_connected':
      return 'Checkout is not set up for this shop. Tell the shopper the owner will send payment details, then call escalate.';
    case 'out_of_stock':
      return 'That is no longer available. Offer the waitlist instead of a payment link.';
    case 'unknown_variant':
      return 'Call search_products again and use a variantId it returned.';
    default:
      return 'The link could not be created. Tell the shopper the owner will follow up, then call escalate.';
  }
}

// ---------------------------------------------------------------------------

export const SHOPPER_TOOLS: Tool[] = [
  searchProducts,
  checkStock,
  getCustomerHistory,
  createPaymentLink,
  addToWaitlist,
  checkOrderStatus,
  getPolicy,
  escalate,
];

export const SHOPPER_TOOL_DEFINITIONS: ToolDefinition[] = SHOPPER_TOOLS.map((tool) => tool.definition);

const BY_NAME = new Map(SHOPPER_TOOLS.map((tool) => [tool.definition.name, tool]));

/**
 * Runs one tool call. A tool that throws returns an error to the model rather than
 * killing the turn — a shopper waiting on a reply should not pay for a transient
 * database error with silence.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext
): Promise<unknown> {
  const tool = BY_NAME.get(name);
  if (!tool) return { error: `unknown tool: ${name}` };

  try {
    return await tool.handler(args, context);
  } catch (error) {
    console.error(`[agent] tool ${name} failed`, error);
    await logEvent(context.merchantId, 'agent.tool_failed', {
      conversationId: context.conversationId,
      tool: name,
      message: error instanceof Error ? error.message : String(error),
    });
    return { error: 'tool_failed', instruction: 'That lookup failed. Call escalate rather than guessing.' };
  }
}

function formatMoney(cents: number, currency: string): string {
  const symbol = currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : '$';
  return `${symbol}${(cents / 100).toFixed(2)}`;
}

/**
 * Search terms come from a shopper's message, so they are untrusted. PostgREST
 * `or()` filters are comma-separated and parenthesised, and `%` and `_` are ilike
 * wildcards — all of them are stripped rather than escaped, because none of them
 * are meaningful in a product name.
 */
function escapeSearchTerm(term: string): string {
  return term.replace(/[,()%_*\\"']/g, '').trim();
}
