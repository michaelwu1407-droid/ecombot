import { supabaseAdmin } from './supabase/admin';
import { logEvent } from './log';
import { getMessagingProvider } from './messaging';

/**
 * Voice learning (BUILD_SPEC §4.7 step 10, §1.6).
 *
 * "Voice fidelity is the adoption blocker, not accuracy." Her brand *is* the
 * personal relationship, and the number one reason she says no is "I don't want a
 * bot". Onboarding reads how she already writes so the first draft she sees
 * sounds like her.
 */

const MAX_EXAMPLES = 30;
const MIN_LENGTH = 15;
const MAX_LENGTH = 400;

/**
 * Pulls the merchant's own recent replies from the provider.
 *
 * Degrades rather than fails: a provider that cannot do this leaves the merchant
 * pasting examples instead, which is slower but never blocks going live.
 */
export async function ingestVoiceFromProvider(merchantId: string): Promise<{
  imported: number;
  supported: boolean;
}> {
  const provider = getMessagingProvider();
  if (!provider.listRecentOutboundMessages) return { imported: 0, supported: false };

  const { data: connection } = await supabaseAdmin()
    .from('connections')
    .select('provider_account_id')
    .eq('merchant_id', merchantId)
    .eq('kind', 'instagram')
    .eq('status', 'active')
    .maybeSingle();

  if (!connection?.provider_account_id) return { imported: 0, supported: true };

  try {
    const messages = await provider.listRecentOutboundMessages(connection.provider_account_id, 120);
    const examples = selectVoiceExamples(messages.map((message) => message.text));

    if (!examples.length) return { imported: 0, supported: true };

    await mergeVoiceExamples(merchantId, examples);
    await logEvent(merchantId, 'onboarding.voice_imported', { count: examples.length });

    return { imported: examples.length, supported: true };
  } catch (error) {
    console.error('[onboarding] voice import failed', error);
    await logEvent(merchantId, 'onboarding.voice_import_failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return { imported: 0, supported: true };
  }
}

/**
 * Picks the replies worth learning from.
 *
 * A one-word "yes" teaches nothing, and a 900-character essay is not how she
 * usually writes. What is wanted is the middle: real sentences, in her rhythm.
 * Near-duplicates are dropped so a merchant who answers "still available!" forty
 * times does not get forty examples of it.
 */
export function selectVoiceExamples(texts: string[]): string[] {
  const seen = new Set<string>();
  const chosen: string[] = [];

  for (const raw of texts) {
    const text = raw.trim().replace(/\s+/g, ' ');
    if (text.length < MIN_LENGTH || text.length > MAX_LENGTH) continue;

    // Automated-looking text teaches the wrong voice.
    if (/https?:\/\//i.test(text)) continue;

    // Whitespace is collapsed *after* stripping punctuation, not before: removing
    // an em dash leaves the spaces that surrounded it, and two near-identical
    // replies would otherwise fingerprint differently and both be kept.
    const fingerprint = text
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);

    chosen.push(text);
    if (chosen.length >= MAX_EXAMPLES) break;
  }

  return chosen;
}

export async function mergeVoiceExamples(merchantId: string, examples: string[]): Promise<void> {
  const db = supabaseAdmin();

  const { data: config } = await db
    .from('agent_configs')
    .select('voice_examples')
    .eq('merchant_id', merchantId)
    .maybeSingle();

  const existing = Array.isArray(config?.voice_examples)
    ? (config.voice_examples as unknown[]).filter((entry): entry is string => typeof entry === 'string')
    : [];

  const merged = selectVoiceExamples([...existing, ...examples]);

  await db
    .from('agent_configs')
    .update({ voice_examples: merged, updated_at: new Date().toISOString() })
    .eq('merchant_id', merchantId);
}

/**
 * What still stands between this merchant and a live agent.
 *
 * The bar from §4.7 step 10: a new merchant goes from signup to live agent
 * without anyone touching the database.
 */
export interface OnboardingState {
  instagram: boolean;
  shopify: boolean;
  stripe: boolean;
  voice: boolean;
  policies: boolean;
  live: boolean;
  /** Everything that must be true before going live. */
  readyToGoLive: boolean;
}

export async function getOnboardingState(merchantId: string): Promise<OnboardingState> {
  const db = supabaseAdmin();

  const [connections, config, merchant, products] = await Promise.all([
    db.from('connections').select('kind').eq('merchant_id', merchantId).eq('status', 'active'),
    db
      .from('agent_configs')
      .select('voice_examples, brand_voice, shipping_policy, returns_policy')
      .eq('merchant_id', merchantId)
      .maybeSingle(),
    db.from('merchants').select('status').eq('id', merchantId).maybeSingle(),
    db.from('products').select('id', { count: 'exact', head: true }).eq('merchant_id', merchantId),
  ]);

  const kinds = new Set((connections.data ?? []).map((connection) => connection.kind));
  const voiceExamples = Array.isArray(config.data?.voice_examples) ? config.data.voice_examples : [];

  const instagram = kinds.has('instagram');
  // Shopify is only really connected once the catalogue has actually landed —
  // a token with an empty catalogue would let the agent go live with nothing to
  // ground its answers in.
  const shopify = kinds.has('shopify') && (products.count ?? 0) > 0;
  const voice = voiceExamples.length > 0 || Boolean(config.data?.brand_voice);
  const policies = Boolean(config.data?.shipping_policy || config.data?.returns_policy);

  return {
    instagram,
    shopify,
    stripe: kinds.has('stripe'),
    voice,
    policies,
    live: merchant.data?.status === 'active',
    // Stripe is not required to go live: an agent that answers questions well
    // without taking payment is still worth having, and §4.9 is reached in stages.
    readyToGoLive: instagram && shopify && voice,
  };
}

export async function goLive(merchantId: string): Promise<{ ok: boolean; error?: string }> {
  const state = await getOnboardingState(merchantId);
  if (!state.readyToGoLive) {
    return { ok: false, error: 'Connect Instagram and Shopify, and set the voice, first.' };
  }

  await supabaseAdmin().from('merchants').update({ status: 'active' }).eq('id', merchantId);
  await logEvent(merchantId, 'onboarding.went_live', {});

  return { ok: true };
}
