import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { currentMerchant } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getAgentConfig } from '@/lib/merchants';
import { logEvent } from '@/lib/log';

/**
 * Settings (BUILD_SPEC §2.8 screen 5).
 *
 * Brand voice, discount floor, escalation rules, auto-send, connections. What is
 * deliberately absent: any control that turns off a guardrail, a rate limit, or
 * the messaging-window rules. The merchant can configure the agent but cannot
 * disable the things protecting them (§4.5) — so those settings do not exist as
 * fields, not merely as disabled ones.
 */

/** A hard ceiling the merchant cannot raise, whatever they type. */
const SYSTEM_DISCOUNT_CEILING = 50;

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const params = await searchParams;
  const merchant = await currentMerchant();
  if (!merchant) redirect('/login');

  const config = await getAgentConfig(merchant.id);

  async function save(formData: FormData) {
    'use server';
    const active = await currentMerchant();
    if (!active) redirect('/login');

    const requested = Number.parseInt(String(formData.get('discount_floor_pct') ?? '0'), 10);
    const discountFloor = Number.isFinite(requested)
      ? Math.max(0, Math.min(SYSTEM_DISCOUNT_CEILING, requested))
      : 0;

    const { error } = await supabaseAdmin()
      .from('agent_configs')
      .update({
        brand_voice: String(formData.get('brand_voice') ?? '').trim() || null,
        discount_floor_pct: discountFloor,
        escalation_rules: String(formData.get('escalation_rules') ?? '').trim() || null,
        shipping_policy: String(formData.get('shipping_policy') ?? '').trim() || null,
        returns_policy: String(formData.get('returns_policy') ?? '').trim() || null,
        auto_send: formData.get('auto_send') === 'on',
        updated_at: new Date().toISOString(),
      })
      .eq('merchant_id', active.id);

    if (error) redirect(`/settings?error=${encodeURIComponent(error.message)}`);

    await logEvent(active.id, 'settings.updated', {
      autoSend: formData.get('auto_send') === 'on',
      discountFloor,
    });

    revalidatePath('/settings');
    redirect('/settings?saved=1');
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>

      {params.saved && (
        <p className="mt-6 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
          Saved. The agent uses this from its next reply.
        </p>
      )}
      {params.error && (
        <p className="mt-6 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {params.error}
        </p>
      )}

      <form action={save} className="mt-8 flex flex-col gap-10">
        <section>
          <h2 className="text-base font-medium">Sending</h2>
          <label className="mt-3 flex items-start gap-3">
            <input
              type="checkbox"
              name="auto_send"
              defaultChecked={config.auto_send}
              className="mt-1"
            />
            <span className="text-sm">
              <span className="font-medium">Let the agent reply on its own</span>
              <span className="mt-0.5 block text-muted">
                Off by default. While it is off, every reply waits for you on the Approvals
                screen. Most owners leave it off for the first week, watch how it writes, then
                turn it on.
              </span>
            </span>
          </label>
        </section>

        <section>
          <h2 className="text-base font-medium">Voice</h2>
          <p className="mt-1 text-sm text-muted">
            How you sound. The agent also learns from replies you have written and from any
            edits you make on the Approvals screen.
          </p>
          <textarea
            name="brand_voice"
            defaultValue={config.brand_voice ?? ''}
            rows={4}
            placeholder="Warm and short. First names. No exclamation marks. Sign off with x."
            className="mt-3 w-full resize-y rounded-md border border-line px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </section>

        <section>
          <h2 className="text-base font-medium">Discounts</h2>
          <label className="mt-3 flex flex-col gap-1.5 text-sm">
            Most the agent may ever take off
            <span className="flex items-center gap-2">
              <input
                type="number"
                name="discount_floor_pct"
                min={0}
                max={SYSTEM_DISCOUNT_CEILING}
                defaultValue={config.discount_floor_pct}
                className="w-24 rounded-md border border-line px-3 py-2 text-sm tabular outline-none focus:border-accent"
              />
              <span className="text-muted">%</span>
            </span>
            <span className="text-xs text-muted">
              Zero means it never offers a discount. Capped at {SYSTEM_DISCOUNT_CEILING}%.
            </span>
          </label>
        </section>

        <section>
          <h2 className="text-base font-medium">When to fetch you</h2>
          <p className="mt-1 text-sm text-muted">
            It already hands over complaints, returns, disputes and anything about a reaction to
            a product. Add anything else you want to handle yourself.
          </p>
          <textarea
            name="escalation_rules"
            defaultValue={config.escalation_rules ?? ''}
            rows={3}
            placeholder="Anything about wholesale or press. Anyone asking to collect in person."
            className="mt-3 w-full resize-y rounded-md border border-line px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </section>

        <section>
          <h2 className="text-base font-medium">Policies</h2>
          <p className="mt-1 text-sm text-muted">
            In your own words. The agent quotes these rather than guessing — and if a policy is
            blank, it fetches you instead of inventing one.
          </p>

          <label className="mt-3 flex flex-col gap-1.5 text-sm">
            Shipping
            <textarea
              name="shipping_policy"
              defaultValue={config.shipping_policy ?? ''}
              rows={3}
              placeholder="Free over $150. Otherwise $12. Ships next business day, 2-4 days within the country."
              className="w-full resize-y rounded-md border border-line px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </label>

          <label className="mt-4 flex flex-col gap-1.5 text-sm">
            Returns
            <textarea
              name="returns_policy"
              defaultValue={config.returns_policy ?? ''}
              rows={3}
              placeholder="30 days, unworn with tags. Sale items are final."
              className="w-full resize-y rounded-md border border-line px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </label>
        </section>

        <div className="flex items-center gap-4">
          <button className="rounded-md bg-ink px-5 py-2 text-sm font-medium text-white">
            Save
          </button>
          <Link href="/settings/connections" className="text-sm text-accent hover:underline">
            Connections
          </Link>
        </div>
      </form>
    </main>
  );
}
