import { currentMerchant } from '@/lib/supabase/server';

/**
 * Placeholder. The real dashboard — revenue generated, response time,
 * conversations handled, recovered sales (§2.8) — is built in stage 8, after the
 * agent loop works. Screens before the loop would be screens showing nothing.
 */
export default async function DashboardPage() {
  const merchant = await currentMerchant();

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">
        {merchant?.business_name ?? 'Dashboard'}
      </h1>
      <p className="mt-2 text-sm text-muted">
        Signed in as {merchant?.email ?? 'unknown'} — status {merchant?.status ?? 'unknown'}.
      </p>
      <p className="mt-8 text-sm text-muted">
        Metrics arrive once the agent is live on your account.
      </p>
    </main>
  );
}
