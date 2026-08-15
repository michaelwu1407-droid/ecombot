import { supabaseAdmin } from '../supabase/admin';
import { logEvent } from '../log';
import { checkProactiveLimits } from '../limits';
import { messagingWindowState } from '../messaging';
import { runShopperTurn } from '../agent/run';

/**
 * Restock notification (BUILD_SPEC §2.5).
 *
 * "Sold out is a dead end that should be a waitlist. Forty people ask about a
 * sold-out size; she restocks and has no list." (§1.3)
 *
 * This is the payoff for the waitlist, and it is where the messaging window bites
 * hardest: an item comes back days later, by which point most of these shoppers
 * are outside the 24-hour window and their notice is queued for the merchant to
 * approve. That is deliberate — see the messaging-window note in the build log.
 */

export interface RestockResult {
  candidates: number;
  notified: number;
  queued: number;
  skipped: number;
}

export async function runRestockCheck(merchantId: string): Promise<RestockResult> {
  const db = supabaseAdmin();
  const result: RestockResult = { candidates: 0, notified: 0, queued: 0, skipped: 0 };

  // Waiting entries whose product is back in stock. Joined rather than looped so
  // the hourly sweep is one query per merchant, not one per waitlist entry.
  const { data: entries, error } = await db
    .from('waitlist_entries')
    .select(
      'id, customer_id, conversation_id, product_id, products!inner(title, variant_title, available, inventory_quantity)'
    )
    .eq('merchant_id', merchantId)
    .eq('status', 'waiting')
    .eq('products.available', true)
    .limit(100);

  if (error) throw error;

  result.candidates = entries?.length ?? 0;

  for (const entry of entries ?? []) {
    const product = entry.products as unknown as {
      title: string;
      variant_title: string | null;
      available: boolean;
      inventory_quantity: number;
    };

    if (!entry.conversation_id) {
      // No thread to reply into. Left waiting rather than dropped — the merchant
      // can still see the list.
      result.skipped += 1;
      continue;
    }

    // Past 7 days from the shopper's last message there is no delivery route at
    // all. Drafting one anyway would put a notice in the merchant's approval queue
    // that fails the moment they tap send — worse than never offering it.
    const { data: conversation } = await db
      .from('conversations')
      .select('last_inbound_at')
      .eq('id', entry.conversation_id)
      .maybeSingle();

    const window = messagingWindowState(
      conversation?.last_inbound_at ? new Date(conversation.last_inbound_at) : null
    );

    if (window.state === 'closed') {
      await db
        .from('waitlist_entries')
        .update({ status: 'expired' })
        .eq('id', entry.id);
      result.skipped += 1;
      await logEvent(merchantId, 'restock.skipped', {
        entryId: entry.id,
        reason: 'messaging window closed',
      });
      continue;
    }

    const limit = await checkProactiveLimits({ merchantId, customerId: entry.customer_id });
    if (!limit.allowed) {
      result.skipped += 1;
      await logEvent(merchantId, 'restock.skipped', { entryId: entry.id, reason: limit.reason });
      continue;
    }

    const name = [product.title, product.variant_title].filter(Boolean).join(' in a ');

    const turn = await runShopperTurn({
      merchantId,
      conversationId: entry.conversation_id,
      customerId: entry.customer_id,
      proactive: {
        kind: 'restock',
        brief:
          `${name} is back in stock. Tell this customer briefly and warmly, in one or two sentences, ` +
          `referring back to the fact they asked about it. Check stock first. Do not push — just let them know it is available.`,
      },
    });

    // Marked notified whether it sent or queued: the merchant has it either way,
    // and re-queuing the same notice every hour would bury their approvals list.
    if (turn.outcome.status === 'sent' || turn.outcome.status === 'queued') {
      await db
        .from('waitlist_entries')
        .update({ status: 'notified', notified_at: new Date().toISOString() })
        .eq('id', entry.id);

      if (turn.outcome.status === 'sent') result.notified += 1;
      else result.queued += 1;
    } else {
      result.skipped += 1;
    }
  }

  if (result.candidates > 0) {
    await logEvent(merchantId, 'restock.sweep_completed', { ...result });
  }

  return result;
}
