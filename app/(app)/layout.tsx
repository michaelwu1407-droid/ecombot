import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentMerchant } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';

/**
 * Merchant app shell (BUILD_SPEC §2.8).
 *
 * Five screens, in the order they matter: the number, the queue, the assistant,
 * the people, the rules. No inbox — we are not competing with Instagram's own
 * (§2.8), and pretending otherwise would be a worse inbox with fewer features.
 */

const NAV = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/escalations', label: 'Approvals' },
  // Assistant lands in stage 9. Not linked until it exists — a nav item that
  // 404s is worse than one that is not there yet.
  { href: '/customers', label: 'Customers' },
  { href: '/settings', label: 'Settings' },
] as const;

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const merchant = await currentMerchant();
  if (!merchant) redirect('/login');

  // The badge is the reason the merchant opens the app in suggest mode, so it is
  // counted on every page load rather than cached.
  const { count: pending } = await supabaseAdmin()
    .from('messages')
    .select('id, conversations!inner(merchant_id)', { count: 'exact', head: true })
    .eq('conversations.merchant_id', merchant.id)
    .in('status', ['pending_approval', 'blocked']);

  return (
    <div className="min-h-full">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-5xl items-center gap-6 px-6 py-3">
          <span className="text-sm font-semibold tracking-tight">
            {merchant.business_name ?? 'Your shop'}
          </span>

          <nav className="flex flex-1 items-center gap-1">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="relative rounded-md px-3 py-1.5 text-sm text-secondary hover:bg-surface hover:text-ink"
              >
                {item.label}
                {item.href === '/escalations' && (pending ?? 0) > 0 && (
                  <span className="ml-1.5 rounded-full bg-ink px-1.5 py-0.5 text-[11px] font-medium text-white tabular">
                    {pending}
                  </span>
                )}
              </Link>
            ))}
          </nav>

          {merchant.status !== 'active' && (
            <span className="rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs font-medium text-muted">
              {merchant.status}
            </span>
          )}
        </div>
      </header>

      {children}
    </div>
  );
}
