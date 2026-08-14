import { supabaseAdmin } from '@/lib/supabase/admin';
import { syncProducts } from '@/lib/shopify/sync';
import { isAuthorisedCron, unauthorisedCron } from '@/lib/cron';
import { logEvent } from '@/lib/log';

/**
 * Hourly catalogue sync (§4.6).
 *
 * One merchant's broken connection must not stop every other merchant's sync, so
 * failures are recorded per merchant and the loop continues. The founder health
 * view reads those events.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  if (!isAuthorisedCron(req)) return unauthorisedCron();

  const { data: connections, error } = await supabaseAdmin()
    .from('connections')
    .select('merchant_id, merchants!inner(status)')
    .eq('kind', 'shopify')
    .eq('status', 'active')
    .neq('merchants.status', 'paused');

  if (error) {
    console.error('[cron/product-sync] could not list connections', error);
    return Response.json({ error: 'query failed' }, { status: 500 });
  }

  const results: Array<{ merchantId: string; ok: boolean; detail?: string }> = [];

  for (const connection of connections ?? []) {
    const merchantId = connection.merchant_id as string;
    try {
      const result = await syncProducts(merchantId);
      results.push({ merchantId, ok: true, detail: `${result.variantsUpserted} variants` });
    } catch (syncError) {
      const message = syncError instanceof Error ? syncError.message : String(syncError);
      console.error(`[cron/product-sync] merchant ${merchantId} failed`, syncError);
      await logEvent(merchantId, 'shopify.sync_failed', { message });
      results.push({ merchantId, ok: false, detail: message });
    }
  }

  return Response.json({
    ok: true,
    merchants: results.length,
    failed: results.filter((r) => !r.ok).length,
    results,
  });
}
