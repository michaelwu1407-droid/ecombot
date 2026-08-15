import { supabaseAdmin } from './supabase/admin';

/**
 * Dashboard metrics (BUILD_SPEC §2.7).
 *
 * "Immediate, legible ROI. A dollar figure in week one, with no understanding of
 * AI required." So revenue leads, and every other number exists to explain it.
 *
 * Median time to first reply is the headline operational metric — it is the proof
 * of the actual pitch, which is speed (§1.4).
 */

export interface PeriodMetrics {
  revenueCents: number;
  salesCount: number;
  conversations: number;
  /** Median seconds to first reply. Null when nothing was answered in the period. */
  medianFirstResponseSeconds: number | null;
  /** Conversations that ended in a sale, as a share of those that ended. */
  conversionPct: number | null;
  /** Revenue from conversations the agent restarted — revival or restock. */
  recoveredCents: number;
  escalations: number;
}

export interface DashboardMetrics {
  thisWeek: PeriodMetrics;
  lastWeek: PeriodMetrics;
  currency: string;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function getDashboardMetrics(merchantId: string, now = new Date()): Promise<DashboardMetrics> {
  const thisWeekStart = new Date(now.getTime() - WEEK_MS);
  const lastWeekStart = new Date(now.getTime() - 2 * WEEK_MS);

  const [thisWeek, lastWeek, currency] = await Promise.all([
    metricsForPeriod(merchantId, thisWeekStart, now),
    metricsForPeriod(merchantId, lastWeekStart, thisWeekStart),
    merchantCurrency(merchantId),
  ]);

  return { thisWeek, lastWeek, currency };
}

async function metricsForPeriod(merchantId: string, from: Date, to: Date): Promise<PeriodMetrics> {
  const db = supabaseAdmin();
  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  const [sales, conversations] = await Promise.all([
    db
      .from('attributed_sales')
      .select('amount_cents, source')
      .eq('merchant_id', merchantId)
      .gte('created_at', fromIso)
      .lt('created_at', toIso),
    db
      .from('conversations')
      .select('first_response_seconds, outcome, status')
      .eq('merchant_id', merchantId)
      .gte('created_at', fromIso)
      .lt('created_at', toIso),
  ]);

  const saleRows = sales.data ?? [];
  const conversationRows = conversations.data ?? [];

  const revenueCents = saleRows.reduce((total, sale) => total + sale.amount_cents, 0);

  // "Recovered" means the agent restarted a conversation that had gone quiet, or
  // brought someone back for an item that returned. That is money the merchant
  // would not otherwise have seen, which is why it is called out separately.
  const recoveredCents = saleRows
    .filter((sale) => sale.source === 'revival' || sale.source === 'restock')
    .reduce((total, sale) => total + sale.amount_cents, 0);

  const responseTimes = conversationRows
    .map((row) => row.first_response_seconds)
    .filter((seconds): seconds is number => typeof seconds === 'number');

  const decided = conversationRows.filter((row) => row.outcome !== null);
  const won = decided.filter((row) => row.outcome === 'sale');

  return {
    revenueCents,
    salesCount: saleRows.length,
    conversations: conversationRows.length,
    medianFirstResponseSeconds: median(responseTimes),
    // Only conversations that actually reached an outcome count — an open thread
    // is neither a win nor a loss yet, and counting it as a loss would make a busy
    // week look like a bad one.
    conversionPct: decided.length ? Math.round((won.length / decided.length) * 100) : null,
    recoveredCents,
    escalations: conversationRows.filter((row) => row.status === 'escalated').length,
  };
}

async function merchantCurrency(merchantId: string): Promise<string> {
  const { data } = await supabaseAdmin()
    .from('products')
    .select('currency')
    .eq('merchant_id', merchantId)
    .limit(1)
    .maybeSingle();

  return data?.currency ?? 'USD';
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const SYMBOLS: Record<string, string> = { USD: '$', GBP: '£', EUR: '€', AUD: '$', NZD: '$', CAD: '$' };

/** Auto-compact, per the stat-tile contract: 1,284 / 12.9K / $4.2M. */
export function formatMoney(cents: number, currency = 'USD'): string {
  const symbol = SYMBOLS[currency] ?? '$';
  const amount = cents / 100;

  if (Math.abs(amount) >= 1_000_000) return `${symbol}${(amount / 1_000_000).toFixed(1)}M`;
  if (Math.abs(amount) >= 10_000) return `${symbol}${(amount / 1000).toFixed(1)}K`;
  return `${symbol}${amount.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

/** Response time in the units a person would say out loud. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  const hours = seconds / 3600;
  return hours < 24 ? `${hours.toFixed(1)} hr` : `${Math.round(hours / 24)} days`;
}

export interface Delta {
  pct: number;
  direction: 'up' | 'down' | 'flat';
  /** Whether this movement is good news, which is not the same as "up". */
  good: boolean;
}

/**
 * @param lowerIsBetter true for response time, where down is the win
 */
export function delta(current: number | null, previous: number | null, lowerIsBetter = false): Delta | null {
  if (current === null || previous === null || previous === 0) return null;

  const change = ((current - previous) / previous) * 100;
  const rounded = Math.round(change);

  if (rounded === 0) return { pct: 0, direction: 'flat', good: true };

  const direction = rounded > 0 ? 'up' : 'down';
  return { pct: Math.abs(rounded), direction, good: lowerIsBetter ? direction === 'down' : direction === 'up' };
}
