import { supabaseAdmin } from './supabase/admin';
import { supabaseServer } from './supabase/server';

/**
 * Founder views (BUILD_SPEC §2.8 screens 7-8).
 *
 * Merchant list and health. These read across every merchant, so access is
 * checked against `platform_admins` rather than merchant ownership — and checked
 * here, in one place, rather than in each page.
 */

export async function requirePlatformAdmin(): Promise<boolean> {
  const supabase = await supabaseServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return false;

  const { data } = await supabaseAdmin()
    .from('platform_admins')
    .select('auth_user_id')
    .eq('auth_user_id', auth.user.id)
    .maybeSingle();

  return Boolean(data);
}

export interface MerchantSummary {
  id: string;
  businessName: string | null;
  email: string;
  status: string;
  createdAt: string;
  connections: string[];
  conversationsLast7Days: number;
  revenueCentsLast7Days: number;
  lastActivityAt: string | null;
  autoSend: boolean;
}

export async function listMerchants(): Promise<MerchantSummary[]> {
  const db = supabaseAdmin();
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();

  const [merchants, connections, conversations, sales, configs] = await Promise.all([
    db.from('merchants').select('id, business_name, email, status, created_at'),
    db.from('connections').select('merchant_id, kind').eq('status', 'active'),
    db.from('conversations').select('merchant_id, last_message_at').gte('created_at', weekAgo),
    db.from('attributed_sales').select('merchant_id, amount_cents').gte('created_at', weekAgo),
    db.from('agent_configs').select('merchant_id, auto_send'),
  ]);

  const byMerchant = <T extends { merchant_id: string }>(rows: T[] | null) => {
    const map = new Map<string, T[]>();
    for (const row of rows ?? []) {
      const list = map.get(row.merchant_id) ?? [];
      list.push(row);
      map.set(row.merchant_id, list);
    }
    return map;
  };

  const connectionsBy = byMerchant(connections.data);
  const conversationsBy = byMerchant(conversations.data);
  const salesBy = byMerchant(sales.data);
  const autoSendBy = new Map((configs.data ?? []).map((config) => [config.merchant_id, config.auto_send]));

  return (merchants.data ?? [])
    .map((merchant) => {
      const merchantConversations = conversationsBy.get(merchant.id) ?? [];
      const lastActivity = merchantConversations
        .map((conversation) => conversation.last_message_at)
        .filter((value): value is string => Boolean(value))
        .sort()
        .pop();

      return {
        id: merchant.id,
        businessName: merchant.business_name,
        email: merchant.email,
        status: merchant.status,
        createdAt: merchant.created_at,
        connections: (connectionsBy.get(merchant.id) ?? []).map((connection) => connection.kind),
        conversationsLast7Days: merchantConversations.length,
        revenueCentsLast7Days: (salesBy.get(merchant.id) ?? []).reduce(
          (total, sale) => total + sale.amount_cents,
          0
        ),
        lastActivityAt: lastActivity ?? null,
        autoSend: autoSendBy.get(merchant.id) ?? false,
      };
    })
    .sort((a, b) => b.revenueCentsLast7Days - a.revenueCentsLast7Days);
}

export interface HealthIssue {
  kind: string;
  merchantId: string | null;
  businessName: string | null;
  count: number;
  lastSeenAt: string;
  detail: string | null;
}

/** The event kinds worth waking up for. */
const WATCHED = [
  'reply.send_failed',
  'inbound.ingest_failed',
  'inbound.unmapped_account',
  'agent.model_failed',
  'agent.turn_failed',
  'agent.tool_failed',
  'shopify.sync_failed',
  'stripe.processing_failed',
  'limit.replies_per_hour_hit',
  'guardrail.blocked',
  'memory.extraction_failed',
  'comment.processing_failed',
] as const;

export async function getHealth(hours = 24): Promise<{
  issues: HealthIssue[];
  silentAgents: MerchantSummary[];
}> {
  const db = supabaseAdmin();
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();

  const [events, merchants] = await Promise.all([
    db
      .from('event_log')
      .select('kind, merchant_id, payload, created_at')
      .in('kind', [...WATCHED])
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(500),
    listMerchants(),
  ]);

  const names = new Map(merchants.map((merchant) => [merchant.id, merchant.businessName]));
  const grouped = new Map<string, HealthIssue>();

  for (const event of events.data ?? []) {
    const key = `${event.kind}:${event.merchant_id ?? 'platform'}`;
    const existing = grouped.get(key);

    if (existing) {
      existing.count += 1;
      continue;
    }

    const payload = (event.payload ?? {}) as Record<string, unknown>;
    grouped.set(key, {
      kind: event.kind,
      merchantId: event.merchant_id,
      businessName: event.merchant_id ? (names.get(event.merchant_id) ?? null) : null,
      count: 1,
      lastSeenAt: event.created_at,
      detail: typeof payload.message === 'string' ? payload.message : null,
    });
  }

  // An active merchant with no conversations is the failure that looks like
  // nothing — no error anywhere, and a merchant quietly getting no value.
  const silentAgents = merchants.filter(
    (merchant) => merchant.status === 'active' && merchant.conversationsLast7Days === 0
  );

  return {
    issues: [...grouped.values()].sort((a, b) => b.count - a.count),
    silentAgents,
  };
}
