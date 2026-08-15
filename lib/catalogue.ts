import { supabaseAdmin } from './supabase/admin';

/**
 * Is the catalogue fresh enough to quote from? (C6)
 *
 * When a Shopify token is revoked, the daily check marks the connection expired —
 * and until this existed, nothing stopped the agent. It carried on answering from
 * `products` rows that were days or weeks stale, quoting prices and stock that no
 * longer existed, silently. That is the "never wrong in front of a customer"
 * failure (§1.4) in its purest form: confident, specific, and wrong.
 *
 * Stale means the agent stops making price and stock claims and hands over.
 * Answering nothing is recoverable; quoting last week's price is not.
 */

/** Sync runs hourly. A day's grace absorbs an outage without going stale. */
export const MAX_CATALOGUE_AGE_MS = 24 * 60 * 60 * 1000;

export type CatalogueState =
  | { fresh: true; lastSyncedAt: Date }
  | { fresh: false; reason: 'not_connected' | 'connection_expired' | 'stale' | 'empty'; lastSyncedAt: Date | null };

export async function catalogueState(
  merchantId: string,
  now: Date = new Date()
): Promise<CatalogueState> {
  const db = supabaseAdmin();

  const { data: connection } = await db
    .from('connections')
    .select('status')
    .eq('merchant_id', merchantId)
    .eq('kind', 'shopify')
    .maybeSingle();

  if (!connection) return { fresh: false, reason: 'not_connected', lastSyncedAt: null };
  if (connection.status !== 'active') {
    return { fresh: false, reason: 'connection_expired', lastSyncedAt: null };
  }

  const { data: newest } = await db
    .from('products')
    .select('last_synced_at')
    .eq('merchant_id', merchantId)
    .order('last_synced_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!newest?.last_synced_at) return { fresh: false, reason: 'empty', lastSyncedAt: null };

  const lastSyncedAt = new Date(newest.last_synced_at);
  if (now.getTime() - lastSyncedAt.getTime() > MAX_CATALOGUE_AGE_MS) {
    return { fresh: false, reason: 'stale', lastSyncedAt };
  }

  return { fresh: true, lastSyncedAt };
}

/** What the merchant should be told, in her words. */
export function catalogueWarning(state: CatalogueState): string | null {
  if (state.fresh) return null;

  switch (state.reason) {
    case 'not_connected':
      return 'Shopify is not connected, so the agent cannot answer questions about price or stock.';
    case 'connection_expired':
      return 'Your Shopify connection has stopped working. Until it is reconnected the agent will not quote prices or stock — it will pass those questions to you instead.';
    case 'stale':
      return 'Your catalogue has not updated in over a day. The agent has stopped quoting prices and stock rather than risk giving out old ones.';
    case 'empty':
      return 'No products have synced from Shopify yet.';
  }
}

/** What the agent is told, so it hands over instead of guessing. */
export const STALE_CATALOGUE_INSTRUCTION =
  'The catalogue is not up to date, so you cannot give a price, a size, or whether something is in stock. Do not guess and do not use anything from earlier in this conversation. Tell the shopper you will check and call escalate.';
