import { supabaseAdmin } from './supabase/admin';
import { logEvent } from './log';

/**
 * Runs a job for every active merchant.
 *
 * One merchant's broken connection or bad data must never stop every other
 * merchant's job, so failures are recorded per merchant and the loop continues.
 * Paused merchants are excluded — pausing has to actually stop the sending.
 */
export async function forEachActiveMerchant<T>(
  jobName: string,
  job: (merchantId: string) => Promise<T>
): Promise<{ ok: true; merchants: number; failed: number; results: unknown[] }> {
  const { data: merchants, error } = await supabaseAdmin()
    .from('merchants')
    .select('id')
    .eq('status', 'active');

  if (error) throw error;

  const results: unknown[] = [];
  let failed = 0;

  for (const merchant of merchants ?? []) {
    try {
      results.push({ merchantId: merchant.id, result: await job(merchant.id) });
    } catch (jobError) {
      failed += 1;
      const message = jobError instanceof Error ? jobError.message : String(jobError);
      console.error(`[cron/${jobName}] merchant ${merchant.id} failed`, jobError);
      await logEvent(merchant.id, `${jobName}.failed`, { message });
      results.push({ merchantId: merchant.id, error: message });
    }
  }

  return { ok: true, merchants: merchants?.length ?? 0, failed, results };
}
