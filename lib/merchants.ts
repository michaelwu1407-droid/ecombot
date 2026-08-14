import { supabaseAdmin } from './supabase/admin';

/**
 * Creates the merchant row and its default config for a newly signed-up user.
 *
 * The defaults encode two decisions from the spec that must not drift: suggest
 * mode on (§3.4 — the agent drafts, the merchant approves, which is how the
 * "I don't want a bot" objection gets answered), and a zero discount floor until
 * the merchant sets one.
 */
export async function provisionMerchant(params: {
  authUserId: string;
  email: string;
  businessName?: string | null;
}): Promise<{ merchantId: string }> {
  const db = supabaseAdmin();

  const { data: merchant, error } = await db
    .from('merchants')
    .upsert(
      {
        auth_user_id: params.authUserId,
        email: params.email,
        business_name: params.businessName ?? null,
        status: 'pending',
      },
      { onConflict: 'email' }
    )
    .select('id')
    .single();

  if (error) throw error;

  const { error: configError } = await db
    .from('agent_configs')
    .upsert({ merchant_id: merchant.id, auto_send: false }, { onConflict: 'merchant_id', ignoreDuplicates: true });

  if (configError) throw configError;

  return { merchantId: merchant.id };
}

/** Merchant config as the agent needs it. Throws if the merchant has no config row. */
export async function getAgentConfig(merchantId: string) {
  const { data, error } = await supabaseAdmin()
    .from('agent_configs')
    .select(
      'brand_voice, voice_examples, discount_floor_pct, escalation_rules, auto_send, active_hours, shipping_policy, returns_policy'
    )
    .eq('merchant_id', merchantId)
    .single();

  if (error) throw error;
  return data;
}
