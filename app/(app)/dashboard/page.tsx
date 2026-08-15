import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentMerchant } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  getDashboardMetrics,
  formatMoney,
  formatDuration,
  delta,
  type Delta,
} from '@/lib/metrics';

/**
 * The dashboard (BUILD_SPEC §2.8 screen 1).
 *
 * Revenue is the hero figure — exactly one per view — because §1.4 asks for a
 * dollar figure in week one with no understanding of AI required. Everything else
 * is a stat tile explaining how that number happened.
 *
 * No charts. The job of this data is "what is the number, and is it better than
 * last week", and that job is done by a figure and a delta, not by a plot.
 */

export default async function DashboardPage() {
  const merchant = await currentMerchant();
  if (!merchant) redirect('/login');

  const { thisWeek, lastWeek, currency } = await getDashboardMetrics(merchant.id);

  const recentSales = await getRecentSales(merchant.id);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
        <span className="text-sm text-muted">Last 7 days vs the 7 before</span>
      </div>

      {/* Hero figure — the one number the view leads with. */}
      <section className="mt-8">
        <p className="text-sm text-secondary">Revenue generated</p>
        <p className="mt-1 text-5xl font-semibold tracking-tight">
          {formatMoney(thisWeek.revenueCents, currency)}
        </p>
        <div className="mt-2 flex items-center gap-3 text-sm">
          <DeltaBadge delta={delta(thisWeek.revenueCents, lastWeek.revenueCents)} />
          <span className="text-muted">
            {thisWeek.salesCount} {thisWeek.salesCount === 1 ? 'sale' : 'sales'} the agent closed
          </span>
        </div>
      </section>

      <section className="mt-10 grid grid-cols-2 gap-x-8 gap-y-8 sm:grid-cols-4">
        <StatTile
          label="Time to first reply"
          value={formatDuration(thisWeek.medianFirstResponseSeconds)}
          // Down is the win here — speed is the feature (§1.4).
          delta={delta(
            thisWeek.medianFirstResponseSeconds,
            lastWeek.medianFirstResponseSeconds,
            true
          )}
          note="median"
        />
        <StatTile
          label="Conversations handled"
          value={thisWeek.conversations.toLocaleString()}
          delta={delta(thisWeek.conversations, lastWeek.conversations)}
        />
        <StatTile
          label="Recovered sales"
          value={formatMoney(thisWeek.recoveredCents, currency)}
          delta={delta(thisWeek.recoveredCents, lastWeek.recoveredCents)}
          note="from follow-ups and restocks"
        />
        <StatTile
          label="Conversion"
          value={thisWeek.conversionPct === null ? '—' : `${thisWeek.conversionPct}%`}
          delta={delta(thisWeek.conversionPct, lastWeek.conversionPct)}
          note="of finished conversations"
        />
      </section>

      <section className="mt-14">
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-medium">Recent sales</h2>
          <Link href="/customers" className="text-sm text-accent hover:underline">
            All customers
          </Link>
        </div>

        {recentSales.length === 0 ? (
          <p className="mt-4 rounded-lg border border-line bg-surface px-4 py-8 text-center text-sm text-muted">
            No sales yet. They will appear here the moment the agent closes one.
          </p>
        ) : (
          <table className="mt-4 w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs font-medium text-muted">
                <th className="pb-2 font-medium">Customer</th>
                <th className="pb-2 font-medium">Came from</th>
                <th className="pb-2 font-medium">When</th>
                <th className="pb-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {recentSales.map((sale) => (
                <tr key={sale.id} className="border-b border-line/60">
                  <td className="py-2.5">
                    {sale.conversationId ? (
                      <Link
                        href={`/customers/${sale.customerId}`}
                        className="hover:text-accent hover:underline"
                      >
                        {sale.handle ?? sale.name ?? 'Unknown'}
                      </Link>
                    ) : (
                      (sale.handle ?? 'Unknown')
                    )}
                  </td>
                  <td className="py-2.5 text-secondary">{SOURCE_LABELS[sale.source] ?? sale.source}</td>
                  <td className="py-2.5 text-muted">{formatWhen(sale.createdAt)}</td>
                  <td className="py-2.5 text-right tabular">
                    {formatMoney(sale.amountCents, currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}

const SOURCE_LABELS: Record<string, string> = {
  dm: 'A direct message',
  comment: 'A comment on a post',
  story_reply: 'A story reply',
  revival: 'A follow-up',
  restock: 'A restock notice',
};

function StatTile({
  label,
  value,
  delta: change,
  note,
}: {
  label: string;
  value: string;
  delta: Delta | null;
  note?: string;
}) {
  return (
    <div>
      <p className="text-sm text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs">
        <DeltaBadge delta={change} />
        {note && <span className="text-muted">{note}</span>}
      </div>
    </div>
  );
}

/**
 * Colour is direction × whether up is good, and it never carries the meaning
 * alone — the arrow and the number say it too.
 */
function DeltaBadge({ delta: change }: { delta: Delta | null }) {
  if (!change) return <span className="text-xs text-muted">no comparison yet</span>;

  if (change.direction === 'flat') {
    return <span className="text-xs text-muted">level with last week</span>;
  }

  return (
    <span
      className="text-xs font-medium tabular"
      style={{ color: change.good ? 'var(--color-good)' : 'var(--color-critical)' }}
    >
      {change.direction === 'up' ? '↑' : '↓'} {change.pct}%
    </span>
  );
}

function formatWhen(iso: string): string {
  const elapsed = Date.now() - new Date(iso).getTime();
  const hours = elapsed / 3_600_000;
  if (hours < 1) return 'just now';
  if (hours < 24) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

async function getRecentSales(merchantId: string) {
  const { data } = await supabaseAdmin()
    .from('attributed_sales')
    .select('id, amount_cents, source, created_at, conversation_id, conversations(customer_id, customers(handle, name))')
    .eq('merchant_id', merchantId)
    .order('created_at', { ascending: false })
    .limit(8);

  return (data ?? []).map((sale) => {
    const conversation = sale.conversations as unknown as {
      customer_id: string;
      customers: { handle: string | null; name: string | null } | null;
    } | null;

    return {
      id: sale.id,
      amountCents: sale.amount_cents,
      source: sale.source,
      createdAt: sale.created_at,
      conversationId: sale.conversation_id,
      customerId: conversation?.customer_id ?? null,
      handle: conversation?.customers?.handle ?? null,
      name: conversation?.customers?.name ?? null,
    };
  });
}
