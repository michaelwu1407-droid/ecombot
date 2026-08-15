import { supabaseAdmin } from './supabase/admin';
import { logEvent } from './log';

/**
 * Linking an Instagram shopper to a Shopify customer.
 *
 * See `0010_customer_identity.sql` for why this is hard. The rule is: **certain
 * joins happen silently, likely joins get proposed, nothing is ever guessed.**
 *
 * The failure this exists to avoid is not "we missed a match". It is telling one
 * shopper about another shopper's orders, from the merchant's own account.
 */

// ---------------------------------------------------------------------------
// Tier 1 — the handle is already in Shopify
// ---------------------------------------------------------------------------

/**
 * Pulls an Instagram handle out of an order note, a custom attribute or a tag.
 *
 * Boutiques who sell in DMs routinely write "IG: @sarah_c" into the order. It is
 * unambiguous, it is free, and it is the highest-yield tier precisely because
 * nobody thinks to look there.
 *
 * Deliberately strict: an email address contains an @ and so does a mention of
 * someone else, so the handle has to be introduced as one.
 */
export function extractHandle(...sources: Array<string | null | undefined>): string | null {
  const text = sources.filter(Boolean).join(' \n ');
  if (!text) return null;

  // "ig: @sarah_c", "instagram — @sarah_c", "IG @sarah_c"
  const labelled = text.match(
    /\b(?:ig|insta|instagram)\b[\s:@—–-]*@?([a-z0-9._]{2,30})\b/i
  );
  if (labelled) return normaliseHandle(labelled[1]);

  // A bare @handle, but only when it is not part of an email address.
  const bare = text.match(/(?:^|[\s,;(])@([a-z0-9._]{2,30})\b/i);
  if (bare) return normaliseHandle(bare[1]);

  return null;
}

export function normaliseHandle(handle: string): string {
  return handle.trim().replace(/^@/, '').toLowerCase();
}

// ---------------------------------------------------------------------------
// Joining
// ---------------------------------------------------------------------------

export type JoinReason = 'handle_in_shopify' | 'email_at_checkout' | 'merchant_confirmed';

/**
 * Merges a Shopify-seeded record into the Instagram-side one.
 *
 * The Instagram record survives, because that is the identity every conversation,
 * waitlist entry and message already points at. What moves across is what Shopify
 * knew and we did not: the email, the Shopify id, and the money.
 *
 * Never overwrites a value we already have with one from the other side —
 * accumulated memory is the asset (§1.5), and the newer record is not automatically
 * the better one.
 */
export async function joinCustomers(params: {
  merchantId: string;
  instagramCustomerId: string;
  shopifyCustomerId: string;
  reason: JoinReason;
}): Promise<boolean> {
  const db = supabaseAdmin();
  if (params.instagramCustomerId === params.shopifyCustomerId) return false;

  const [{ data: target }, { data: source }] = await Promise.all([
    db
      .from('customers')
      .select('id, email, shopify_customer_id, size, preferences, budget_range, lifetime_value_cents, name')
      .eq('id', params.instagramCustomerId)
      .eq('merchant_id', params.merchantId)
      .maybeSingle(),
    db
      .from('customers')
      .select('id, email, shopify_customer_id, size, preferences, budget_range, lifetime_value_cents, name')
      .eq('id', params.shopifyCustomerId)
      .eq('merchant_id', params.merchantId)
      .maybeSingle(),
  ]);

  if (!target || !source) return false;

  const patch: Record<string, unknown> = {};
  if (!target.email && source.email) patch.email = source.email;
  if (!target.shopify_customer_id && source.shopify_customer_id) {
    patch.shopify_customer_id = source.shopify_customer_id;
  }
  if (!target.size && source.size) patch.size = source.size;
  if (!target.name && source.name) patch.name = source.name;
  if (!target.budget_range && source.budget_range) patch.budget_range = source.budget_range;

  // What she has actually spent is the sum of both sides, not the larger one.
  patch.lifetime_value_cents =
    (target.lifetime_value_cents ?? 0) + (source.lifetime_value_cents ?? 0);

  patch.preferences = {
    ...((source.preferences ?? {}) as Record<string, unknown>),
    ...((target.preferences ?? {}) as Record<string, unknown>),
  };

  await db.from('customers').update(patch).eq('id', target.id);

  // Anything pointing at the Shopify-side record now points at the surviving one.
  await db
    .from('conversations')
    .update({ customer_id: target.id })
    .eq('customer_id', source.id);
  await db
    .from('waitlist_entries')
    .update({ customer_id: target.id })
    .eq('customer_id', source.id);

  await db.from('customers').delete().eq('id', source.id);

  await logEvent(params.merchantId, 'identity.joined', {
    customerId: target.id,
    reason: params.reason,
  });

  return true;
}

/** Tier 2 — a paid checkout tells us the email, which is a certain join. */
export async function joinOnEmail(
  merchantId: string,
  instagramCustomerId: string,
  email: string
): Promise<boolean> {
  const normalised = email.trim().toLowerCase();
  if (!normalised) return false;

  const db = supabaseAdmin();

  const { data: seeded } = await db
    .from('customers')
    .select('id')
    .eq('merchant_id', merchantId)
    .ilike('email', normalised)
    .neq('id', instagramCustomerId)
    .maybeSingle();

  if (!seeded) {
    // Nobody to merge with — just record the email against them.
    await db
      .from('customers')
      .update({ email: normalised })
      .eq('id', instagramCustomerId)
      .is('email', null);
    return false;
  }

  return joinCustomers({
    merchantId,
    instagramCustomerId,
    shopifyCustomerId: seeded.id,
    reason: 'email_at_checkout',
  });
}

// ---------------------------------------------------------------------------
// Tier 3 — propose, never merge
// ---------------------------------------------------------------------------

export interface MatchProposal {
  id: string;
  instagramLabel: string;
  candidateLabel: string;
  evidence: string;
}

/**
 * Names alone are never enough to merge, but they are enough to ask about.
 *
 * Only proposed when the name is distinctive — a full name with two parts. "Sarah"
 * matching "Sarah" would generate a proposal a week and train her to tap No.
 */
export async function proposeNameMatch(params: {
  merchantId: string;
  instagramCustomerId: string;
  instagramName: string;
}): Promise<boolean> {
  const name = params.instagramName.trim();
  if (name.split(/\s+/).length < 2 || name.length < 6) return false;

  const db = supabaseAdmin();

  const { data: candidates } = await db
    .from('customers')
    .select('id, name, email, lifetime_value_cents')
    .eq('merchant_id', params.merchantId)
    .eq('first_seen_source', 'shopify')
    .is('platform_user_id', null)
    .ilike('name', name)
    .limit(2);

  // More than one match means the name is not distinctive after all.
  if (!candidates || candidates.length !== 1) return false;

  const candidate = candidates[0];

  const { error } = await db.from('customer_match_proposals').insert({
    merchant_id: params.merchantId,
    customer_id: params.instagramCustomerId,
    candidate_customer_id: candidate.id,
    evidence: `Same name, and ${maskEmail(candidate.email)} has ordered before.`,
  });

  // 23505 = already asked about this pair.
  if (error && error.code !== '23505') throw error;
  return !error;
}

export async function getMatchProposals(merchantId: string): Promise<MatchProposal[]> {
  const { data } = await supabaseAdmin()
    .from('customer_match_proposals')
    .select(
      'id, evidence, customer:customers!customer_match_proposals_customer_id_fkey(handle, name), candidate:customers!customer_match_proposals_candidate_customer_id_fkey(name, email)'
    )
    .eq('merchant_id', merchantId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(5);

  return (data ?? []).map((row) => {
    const customer = row.customer as unknown as { handle: string | null; name: string | null };
    const candidate = row.candidate as unknown as { name: string | null; email: string | null };

    return {
      id: row.id,
      instagramLabel: customer?.handle ? `@${customer.handle}` : (customer?.name ?? 'this shopper'),
      candidateLabel: candidate?.name ?? maskEmail(candidate?.email ?? null),
      evidence: row.evidence,
    };
  });
}

export async function resolveMatchProposal(
  merchantId: string,
  proposalId: string,
  accepted: boolean
): Promise<void> {
  const db = supabaseAdmin();

  const { data: proposal } = await db
    .from('customer_match_proposals')
    .select('id, customer_id, candidate_customer_id, status')
    .eq('id', proposalId)
    .eq('merchant_id', merchantId)
    .maybeSingle();

  if (!proposal || proposal.status !== 'pending') return;

  if (accepted) {
    await joinCustomers({
      merchantId,
      instagramCustomerId: proposal.customer_id,
      shopifyCustomerId: proposal.candidate_customer_id,
      reason: 'merchant_confirmed',
    });
  }

  await db
    .from('customer_match_proposals')
    .update({ status: accepted ? 'accepted' : 'rejected', resolved_at: new Date().toISOString() })
    .eq('id', proposalId);
}

/** Enough for her to recognise the person, without printing the address in full. */
export function maskEmail(email: string | null): string {
  if (!email) return 'a past customer';
  const [local, domain] = email.split('@');
  if (!domain) return 'a past customer';
  const shown = local.slice(0, 2);
  return `${shown}${'•'.repeat(Math.max(1, local.length - 2))}@${domain}`;
}
