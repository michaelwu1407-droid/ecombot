import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { currentMerchant } from '@/lib/supabase/server';
import { connectShopify, getConnections } from '@/lib/connections';
import { syncProducts } from '@/lib/shopify/sync';
import { supabaseAdmin } from '@/lib/supabase/admin';

/**
 * Connect Shopify with a custom app admin token (§4.7 step 2).
 *
 * A custom app token rather than an OAuth app: merchants are onboarded personally
 * by the founder, and a public Shopify app means another review queue we do not
 * need to sit in.
 */

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; connected?: string }>;
}) {
  const params = await searchParams;
  const merchant = await currentMerchant();
  if (!merchant) redirect('/login');

  const connections = await getConnections(merchant.id);
  const shopify = connections.find((c) => c.kind === 'shopify');
  const instagram = connections.find((c) => c.kind === 'instagram');

  const { count: productCount } = await supabaseAdmin()
    .from('products')
    .select('id', { count: 'exact', head: true })
    .eq('merchant_id', merchant.id);

  async function saveShopify(formData: FormData) {
    'use server';
    const active = await currentMerchant();
    if (!active) redirect('/login');

    try {
      const shop = await connectShopify({
        merchantId: active.id,
        shopDomain: String(formData.get('shop_domain') ?? ''),
        accessToken: String(formData.get('access_token') ?? ''),
      });

      // First sync runs immediately so the merchant sees their catalogue land
      // rather than waiting up to an hour for the cron.
      const result = await syncProducts(active.id);

      revalidatePath('/settings/connections');
      redirect(
        `/settings/connections?connected=${encodeURIComponent(
          `${shop.shopName} — ${result.variantsUpserted} products synced`
        )}`
      );
    } catch (error) {
      // redirect() throws by design; let it through.
      if (error && typeof error === 'object' && 'digest' in error) throw error;
      const message = error instanceof Error ? error.message : 'Could not connect to Shopify';
      redirect(`/settings/connections?error=${encodeURIComponent(message)}`);
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
      <p className="mt-1 text-sm text-muted">
        The agent answers from your live catalogue, so it never guesses a price.
      </p>

      {params.error && (
        <p className="mt-6 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {params.error}
        </p>
      )}
      {params.connected && (
        <p className="mt-6 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
          Connected: {params.connected}
        </p>
      )}

      <section className="mt-10">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-medium">Instagram</h2>
          <StatusPill connected={Boolean(instagram)} />
        </div>
        <p className="mt-1 text-sm text-muted">
          {instagram
            ? `Connected — account ${instagram.provider_account_id}`
            : 'Connected during onboarding. Ask your account manager if this is not showing.'}
        </p>
      </section>

      <section className="mt-10 border-t border-line pt-8">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-medium">Shopify</h2>
          <StatusPill connected={Boolean(shopify)} />
        </div>

        {shopify ? (
          <p className="mt-1 text-sm text-muted">
            Connected to {shopify.provider_account_id} — {productCount ?? 0} products in sync.
            Re-enter a token below to replace it.
          </p>
        ) : (
          <p className="mt-1 text-sm text-muted">
            In Shopify: Settings → Apps and sales channels → Develop apps → create an app with
            read access to products and inventory, then copy the Admin API access token.
          </p>
        )}

        <form action={saveShopify} className="mt-6 flex flex-col gap-4">
          <label className="flex flex-col gap-1.5 text-sm">
            Store address
            <input
              name="shop_domain"
              required
              placeholder="boutique.myshopify.com"
              defaultValue={shopify?.provider_account_id ?? ''}
              className="rounded-md border border-line px-3 py-2 text-base outline-none focus:border-accent"
            />
          </label>

          <label className="flex flex-col gap-1.5 text-sm">
            Admin API access token
            <input
              name="access_token"
              required
              type="password"
              placeholder="shpat_…"
              className="rounded-md border border-line px-3 py-2 font-mono text-sm outline-none focus:border-accent"
            />
            <span className="text-xs text-muted">
              Stored encrypted. We check it works before saving.
            </span>
          </label>

          <button className="mt-2 self-start rounded-md bg-ink px-4 py-2 text-sm font-medium text-white">
            {shopify ? 'Replace token' : 'Connect Shopify'}
          </button>
        </form>
      </section>
    </main>
  );
}

function StatusPill({ connected }: { connected: boolean }) {
  return (
    <span
      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
        connected ? 'bg-green-100 text-green-800' : 'bg-neutral-100 text-muted'
      }`}
    >
      {connected ? 'Connected' : 'Not connected'}
    </span>
  );
}
