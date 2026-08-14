import { supabaseAdmin } from './supabase/admin';

/**
 * Structured logging into event_log. Every agent iteration lands here (§4.4), and
 * the founder health view (§2.8) reads it.
 *
 * Logging must never be the reason a customer does not get a reply, so failures
 * here are swallowed to stderr rather than thrown.
 */
export async function logEvent(
  merchantId: string | null,
  kind: string,
  payload: Record<string, unknown> = {}
): Promise<void> {
  try {
    await supabaseAdmin().from('event_log').insert({ merchant_id: merchantId, kind, payload });
  } catch (error) {
    console.error(`[event_log] failed to write ${kind}:`, error);
  }
}
