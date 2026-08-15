import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentMerchant } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { formatMoney } from '@/lib/metrics';

/**
 * Customers (BUILD_SPEC §2.8 screen 4).
 *
 * This screen is the moat made visible (§1.5). In store she knows faces and
 * sizes; in DMs everyone is a stranger every time. Month 12 beats month 1 because
 * this list got longer and the rows got richer.
 */

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const merchant = await currentMerchant();
  if (!merchant) redirect('/login');

  const customers = await searchCustomers(merchant.id, q?.trim() ?? '');

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Customers</h1>
        <span className="text-sm text-muted">{customers.length} shown</span>
      </div>

      <form className="mt-6">
        <input
          name="q"
          defaultValue={q ?? ''}
          placeholder="Search by handle, name or size"
          className="w-full rounded-md border border-line px-3 py-2 text-sm outline-none focus:border-accent"
        />
      </form>

      {customers.length === 0 ? (
        <p className="mt-8 rounded-lg border border-line bg-surface px-4 py-10 text-center text-sm text-muted">
          {q ? 'Nobody matches that.' : 'Customers appear here as they message you.'}
        </p>
      ) : (
        <table className="mt-6 w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs font-medium text-muted">
              <th className="pb-2 font-medium">Customer</th>
              <th className="pb-2 font-medium">Size</th>
              <th className="pb-2 font-medium">Last seen</th>
              <th className="pb-2 text-right font-medium">Spent</th>
            </tr>
          </thead>
          <tbody>
            {customers.map((customer) => (
              <tr key={customer.id} className="border-b border-line/60">
                <td className="py-2.5">
                  <Link href={`/customers/${customer.id}`} className="hover:text-accent hover:underline">
                    {customer.handle ? `@${customer.handle}` : (customer.name ?? 'Unknown')}
                  </Link>
                </td>
                <td className="py-2.5 text-secondary">{customer.size ?? '—'}</td>
                <td className="py-2.5 text-muted">{formatWhen(customer.lastSeenAt)}</td>
                <td className="py-2.5 text-right tabular">
                  {customer.lifetimeValueCents > 0 ? formatMoney(customer.lifetimeValueCents) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

async function searchCustomers(merchantId: string, query: string) {
  let builder = supabaseAdmin()
    .from('customers')
    .select('id, handle, name, size, lifetime_value_cents, last_seen_at')
    .eq('merchant_id', merchantId);

  if (query) {
    // Stripped rather than escaped: % and _ are ilike wildcards, and commas split
    // a PostgREST or() filter.
    const safe = query.replace(/[,()%_*\\"']/g, '').trim();
    if (safe) {
      builder = builder.or(`handle.ilike.%${safe}%,name.ilike.%${safe}%,size.ilike.%${safe}%`);
    }
  }

  const { data } = await builder
    .order('last_seen_at', { ascending: false, nullsFirst: false })
    .limit(100);

  return (data ?? []).map((row) => ({
    id: row.id,
    handle: row.handle,
    name: row.name,
    size: row.size,
    lifetimeValueCents: row.lifetime_value_cents,
    lastSeenAt: row.last_seen_at,
  }));
}

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  const hours = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  if (hours < 1) return 'just now';
  if (hours < 24) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
