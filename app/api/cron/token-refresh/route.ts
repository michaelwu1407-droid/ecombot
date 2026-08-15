import { supabaseAdmin } from '@/lib/supabase/admin';
import { isAuthorisedCron, unauthorisedCron } from '@/lib/cron';
import { getShopifyCredentials, verifyShopifyConnection, ShopifyError } from '@/lib/shopify/client';
import { logEvent } from '@/lib/log';

/**
 * Daily credential check (§4.6).
 *
 * Nothing we hold auto-expires today: Shopify custom app tokens are long-lived,
 * Stripe Connect uses account ids rather than refreshable tokens, and the bridge
 * provider holds the Instagram tokens on its side.
 *
 * So this is a health check rather than a refresh — it finds a token that has
 * been revoked or rotated before the merchant discovers it as an agent quoting
 * yesterday's stock. Marking the connection `expired` is what surfaces it on the
 * founder health view.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  if (!isAuthorisedCron(req)) return unauthorisedCron();

  const db = supabaseAdmin();

  const { data: connections, error } = await db
    .from('connections')
    .select('id, merchant_id')
    .eq('kind', 'shopify')
    .eq('status', 'active');

  if (error) {
    console.error('[cron/token-refresh] could not list connections', error);
    return Response.json({ error: 'query failed' }, { status: 500 });
  }

  let checked = 0;
  let expired = 0;

  for (const connection of connections ?? []) {
    checked += 1;

    try {
      const credentials = await getShopifyCredentials(connection.merchant_id);
      if (!credentials) continue;

      await verifyShopifyConnection(credentials);
    } catch (checkError) {
      // Only a rejected token marks the connection dead. A network blip must not
      // knock a working merchant offline.
      const rejected = checkError instanceof ShopifyError && !checkError.retryable;
      if (!rejected) continue;

      expired += 1;
      await db.from('connections').update({ status: 'expired' }).eq('id', connection.id);
      await logEvent(connection.merchant_id, 'connection.shopify_expired', {
        message: checkError instanceof Error ? checkError.message : String(checkError),
      });
    }
  }

  return Response.json({ ok: true, checked, expired });
}
