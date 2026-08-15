import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { currentMerchant } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { formatMoney } from '@/lib/metrics';

/**
 * A customer profile: size, preferences, history, waitlist, past conversations
 * (BUILD_SPEC §2.8 screen 4).
 *
 * Everything here was learned from conversation, never a form (§2.4).
 */

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const merchant = await currentMerchant();
  if (!merchant) redirect('/login');

  const db = supabaseAdmin();

  const { data: customer } = await db
    .from('customers')
    .select('id, handle, name, size, preferences, budget_range, lifetime_value_cents, last_seen_at, created_at')
    .eq('id', id)
    .eq('merchant_id', merchant.id)
    .maybeSingle();

  if (!customer) notFound();

  const [conversations, waitlist] = await Promise.all([
    db
      .from('conversations')
      .select('id, source, status, outcome, created_at, last_message_at, first_response_seconds')
      .eq('merchant_id', merchant.id)
      .eq('customer_id', id)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(20),
    db
      .from('waitlist_entries')
      .select('id, status, created_at, products(title, variant_title, available)')
      .eq('merchant_id', merchant.id)
      .eq('customer_id', id)
      .order('created_at', { ascending: false }),
  ]);

  const preferences = Object.entries((customer.preferences ?? {}) as Record<string, unknown>).filter(
    ([key]) => key !== 'notes'
  );
  const notes = Array.isArray((customer.preferences as Record<string, unknown>)?.notes)
    ? ((customer.preferences as Record<string, unknown>).notes as string[])
    : [];

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <Link href="/customers" className="text-sm text-muted hover:text-ink">
        ← Customers
      </Link>

      <h1 className="mt-3 text-xl font-semibold tracking-tight">
        {customer.handle ? `@${customer.handle}` : (customer.name ?? 'Unknown shopper')}
      </h1>
      <p className="mt-1 text-sm text-muted">
        Known since {new Date(customer.created_at).toLocaleDateString()}
        {customer.lifetime_value_cents > 0 &&
          ` · ${formatMoney(customer.lifetime_value_cents)} spent`}
      </p>

      <section className="mt-8 grid grid-cols-2 gap-6 sm:grid-cols-3">
        <Fact label="Size" value={customer.size} />
        <Fact label="Budget" value={customer.budget_range} />
        {preferences.map(([key, value]) => (
          <Fact key={key} label={key} value={formatPreference(value)} />
        ))}
      </section>

      {notes.length > 0 && (
        <section className="mt-8">
          <h2 className="text-sm font-medium text-secondary">Notes</h2>
          <ul className="mt-2 flex flex-col gap-1 text-sm text-secondary">
            {notes.map((note) => (
              <li key={note}>· {note}</li>
            ))}
          </ul>
        </section>
      )}

      {(waitlist.data?.length ?? 0) > 0 && (
        <section className="mt-10">
          <h2 className="text-sm font-medium text-secondary">Waiting on</h2>
          <ul className="mt-3 flex flex-col gap-2">
            {(waitlist.data ?? []).map((entry) => {
              const product = entry.products as unknown as {
                title: string;
                variant_title: string | null;
                available: boolean;
              } | null;

              return (
                <li
                  key={entry.id}
                  className="flex items-center justify-between rounded-md border border-line px-3 py-2 text-sm"
                >
                  <span>{[product?.title, product?.variant_title].filter(Boolean).join(' — ')}</span>
                  <span className="text-xs text-muted">{WAITLIST_LABELS[entry.status] ?? entry.status}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="mt-10">
        <h2 className="text-sm font-medium text-secondary">Conversations</h2>
        {(conversations.data?.length ?? 0) === 0 ? (
          <p className="mt-3 text-sm text-muted">None yet.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {(conversations.data ?? []).map((conversation) => (
              <li
                key={conversation.id}
                className="flex items-center justify-between rounded-md border border-line px-3 py-2 text-sm"
              >
                <span>{SOURCE_LABELS[conversation.source] ?? conversation.source}</span>
                <span className="flex items-center gap-3 text-xs text-muted">
                  {conversation.outcome === 'sale' && (
                    <span style={{ color: 'var(--color-good)' }}>✓ Sale</span>
                  )}
                  <span>
                    {conversation.last_message_at
                      ? new Date(conversation.last_message_at).toLocaleDateString()
                      : '—'}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function Fact({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <p className="text-xs capitalize text-muted">{label}</p>
      <p className="mt-0.5 text-sm">{value || '—'}</p>
    </div>
  );
}

function formatPreference(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ');
  if (value === null || value === undefined) return '';
  return String(value);
}

const SOURCE_LABELS: Record<string, string> = {
  dm: 'Direct message',
  comment: 'From a comment',
  story_reply: 'Story reply',
};

const WAITLIST_LABELS: Record<string, string> = {
  waiting: 'Waiting',
  notified: 'Told it is back',
  converted: 'Bought it',
  expired: 'Expired',
};
