import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePlatformAdmin, listMerchants, getHealth } from '@/lib/admin';
import { formatMoney } from '@/lib/metrics';

/**
 * Founder view (BUILD_SPEC §2.8 screens 7-8): merchant list and health.
 *
 * Not linked from the merchant app. A merchant who is not an admin gets a 404
 * rather than a permission error — there is no reason for them to learn this
 * exists.
 */

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  if (!(await requirePlatformAdmin())) notFound();

  const [merchants, health] = await Promise.all([listMerchants(), getHealth()]);

  const active = merchants.filter((merchant) => merchant.status === 'active');
  const totalRevenue = merchants.reduce((total, merchant) => total + merchant.revenueCentsLast7Days, 0);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="text-xl font-semibold tracking-tight">Operations</h1>
      <p className="mt-1 text-sm text-muted">
        {active.length} live of {merchants.length} · {formatMoney(totalRevenue)} generated in 7 days
      </p>

      <section className="mt-10">
        <h2 className="text-base font-medium">Health</h2>

        {health.silentAgents.length > 0 && (
          <div className="mt-3 rounded-lg border px-4 py-3" style={{ borderColor: 'var(--color-serious)' }}>
            <p className="flex items-center gap-2 text-sm font-medium">
              <span aria-hidden>⚠</span>
              {health.silentAgents.length} live{' '}
              {health.silentAgents.length === 1 ? 'agent has' : 'agents have'} handled nothing this week
            </p>
            <p className="mt-1 text-sm text-secondary">
              {health.silentAgents.map((merchant) => merchant.businessName ?? merchant.email).join(', ')}
            </p>
            <p className="mt-1 text-xs text-muted">
              No error anywhere — which is what makes this the one worth checking first.
            </p>
          </div>
        )}

        {health.issues.length === 0 ? (
          <p className="mt-3 rounded-lg border border-line bg-surface px-4 py-6 text-center text-sm text-muted">
            Nothing failing in the last 24 hours.
          </p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs font-medium text-muted">
                <th className="pb-2 font-medium">Issue</th>
                <th className="pb-2 font-medium">Merchant</th>
                <th className="pb-2 text-right font-medium">Count</th>
                <th className="pb-2 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody>
              {health.issues.map((issue) => (
                <tr key={`${issue.kind}-${issue.merchantId}`} className="border-b border-line/60">
                  <td className="py-2 font-medium">{ISSUE_LABELS[issue.kind] ?? issue.kind}</td>
                  <td className="py-2 text-secondary">{issue.businessName ?? '—'}</td>
                  <td className="py-2 text-right tabular">{issue.count}</td>
                  <td className="max-w-xs truncate py-2 text-xs text-muted">{issue.detail ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="mt-12">
        <h2 className="text-base font-medium">Merchants</h2>
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs font-medium text-muted">
              <th className="pb-2 font-medium">Merchant</th>
              <th className="pb-2 font-medium">Status</th>
              <th className="pb-2 font-medium">Connected</th>
              <th className="pb-2 text-right font-medium">Conversations</th>
              <th className="pb-2 text-right font-medium">Revenue</th>
            </tr>
          </thead>
          <tbody>
            {merchants.map((merchant) => (
              <tr key={merchant.id} className="border-b border-line/60">
                <td className="py-2.5">
                  <span className="font-medium">{merchant.businessName ?? '—'}</span>
                  <span className="ml-2 text-xs text-muted">{merchant.email}</span>
                </td>
                <td className="py-2.5">
                  <span className="text-secondary">{merchant.status}</span>
                  {merchant.status === 'active' && !merchant.autoSend && (
                    <span className="ml-2 text-xs text-muted">suggest mode</span>
                  )}
                </td>
                <td className="py-2.5 text-xs text-secondary">
                  {merchant.connections.length ? merchant.connections.join(', ') : '—'}
                </td>
                <td className="py-2.5 text-right tabular">{merchant.conversationsLast7Days}</td>
                <td className="py-2.5 text-right tabular">
                  {formatMoney(merchant.revenueCentsLast7Days)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <p className="mt-10 text-sm">
        <Link href="/dashboard" className="text-accent hover:underline">
          Back to the merchant app
        </Link>
      </p>
    </main>
  );
}

const ISSUE_LABELS: Record<string, string> = {
  'reply.send_failed': 'Message failed to send',
  'inbound.ingest_failed': 'Inbound message lost',
  'inbound.unmapped_account': 'Unknown Instagram account',
  'agent.model_failed': 'Model unreachable',
  'agent.turn_failed': 'Agent turn crashed',
  'agent.tool_failed': 'Tool failed',
  'shopify.sync_failed': 'Shopify sync failed',
  'stripe.processing_failed': 'Stripe event failed',
  'limit.replies_per_hour_hit': 'Hourly send limit hit',
  'guardrail.blocked': 'Guardrail blocked a reply',
  'memory.extraction_failed': 'Memory extraction failed',
  'comment.processing_failed': 'Comment capture failed',
};
