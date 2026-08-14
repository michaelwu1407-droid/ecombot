-- Initial schema for the AI sales agent (BUILD_SPEC §4.3).
--
-- Deviations from the spec, all additive and noted in the build report:
--   * merchants.auth_user_id      — RLS needs a link to auth.uid(); email alone is fragile.
--   * platform_admins             — founder views (§2.8 screens 7-8) need a role that reads across merchants.
--   * conversations.provider_conversation_id — Zernio sends are conversation-scoped.
--   * conversations.participant_id — lets us open a DM without an existing thread.
--   * webhook_events              — provider delivery is at-least-once; dedupe is mandatory, not optional.
--   * send_log                    — rate limits must be enforced in code (§1.7), which needs a durable counter.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Core tenancy
-- ---------------------------------------------------------------------------

create table merchants (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  uuid unique references auth.users (id) on delete set null,
  email         text unique not null,
  business_name text,
  vertical      text,                                    -- reserved, unused in v1
  status        text not null default 'pending' check (status in ('pending', 'active', 'paused')),
  created_at    timestamptz not null default now()
);

create table platform_admins (
  auth_user_id uuid primary key references auth.users (id) on delete cascade,
  email        text,
  created_at   timestamptz not null default now()
);

create table connections (
  id                  uuid primary key default gen_random_uuid(),
  merchant_id         uuid not null references merchants (id) on delete cascade,
  kind                text not null check (kind in ('instagram', 'shopify', 'stripe')),
  provider_account_id text,
  credentials         jsonb,                             -- encrypted at rest (lib/crypto.ts)
  expires_at          timestamptz,
  status              text not null default 'active' check (status in ('active', 'expired', 'revoked', 'error')),
  created_at          timestamptz not null default now()
);

-- One live connection per kind per merchant; the provider account must resolve to
-- exactly one merchant or inbound webhook routing is ambiguous.
create unique index connections_merchant_kind_idx on connections (merchant_id, kind);
create unique index connections_provider_account_idx
  on connections (kind, provider_account_id)
  where provider_account_id is not null;

create table agent_configs (
  id                 uuid primary key default gen_random_uuid(),
  merchant_id        uuid not null unique references merchants (id) on delete cascade,
  brand_voice        text,
  voice_examples     jsonb not null default '[]'::jsonb, -- past replies ingested at onboarding
  discount_floor_pct int not null default 0 check (discount_floor_pct between 0 and 100),
  escalation_rules   text,
  auto_send          boolean not null default false,     -- suggest mode by default (§3.4)
  active_hours       jsonb,
  shipping_policy    text,
  returns_policy     text,
  updated_at         timestamptz not null default now()
);

create table skills (
  id          uuid primary key default gen_random_uuid(),
  merchant_id uuid references merchants (id) on delete cascade,  -- null = global skill
  name        text not null,
  content     text not null,                            -- markdown instructions
  enabled     boolean not null default true,
  version     int not null default 1,
  created_by  text not null default 'founder' check (created_by in ('founder', 'operator_agent')),
  created_at  timestamptz not null default now()
);

create index skills_merchant_enabled_idx on skills (merchant_id, enabled);

-- ---------------------------------------------------------------------------
-- Customers and conversations
-- ---------------------------------------------------------------------------

create table customers (
  id                  uuid primary key default gen_random_uuid(),
  merchant_id         uuid not null references merchants (id) on delete cascade,
  platform_user_id    text not null,
  handle              text,
  name                text,
  size                text,
  preferences         jsonb not null default '{}'::jsonb,  -- brands, colours, fit notes
  budget_range        text,
  lifetime_value_cents int not null default 0,
  last_seen_at        timestamptz,
  created_at          timestamptz not null default now(),
  unique (merchant_id, platform_user_id)
);

create table conversations (
  id                       uuid primary key default gen_random_uuid(),
  merchant_id              uuid not null references merchants (id) on delete cascade,
  customer_id              uuid not null references customers (id) on delete cascade,
  source                   text not null check (source in ('dm', 'comment', 'story_reply')),
  status                   text not null default 'active' check (status in ('active', 'stalled', 'escalated', 'closed')),
  provider_conversation_id text,
  participant_id           text,
  first_response_seconds   int,
  last_message_at          timestamptz,
  last_inbound_at          timestamptz,                  -- drives the Meta 24h messaging window
  outcome                  text check (outcome in ('sale', 'no_sale', 'abandoned')),
  created_at               timestamptz not null default now()
);

create index conversations_merchant_status_idx on conversations (merchant_id, status);
create index conversations_last_message_idx on conversations (last_message_at);
create unique index conversations_provider_idx
  on conversations (merchant_id, provider_conversation_id)
  where provider_conversation_id is not null;

create table messages (
  id                  uuid primary key default gen_random_uuid(),
  conversation_id     uuid not null references conversations (id) on delete cascade,
  direction           text not null check (direction in ('inbound', 'outbound')),
  sender              text not null check (sender in ('customer', 'agent', 'merchant')),
  content             text not null,
  tool_calls          jsonb,
  provider_message_id text,
  created_at          timestamptz not null default now()
);

create index messages_conversation_created_idx on messages (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------------

create table products (
  id                  uuid primary key default gen_random_uuid(),
  merchant_id         uuid not null references merchants (id) on delete cascade,
  shopify_product_id  text,
  shopify_variant_id  text not null,
  title               text not null,
  variant_title       text,
  price_cents         int not null,
  currency            text not null default 'USD',
  inventory_quantity  int not null default 0,
  image_url           text,
  available           boolean not null default false,
  last_synced_at      timestamptz not null default now(),
  unique (merchant_id, shopify_variant_id)
);

create index products_merchant_available_idx on products (merchant_id, available);

create table waitlist_entries (
  id              uuid primary key default gen_random_uuid(),
  merchant_id     uuid not null references merchants (id) on delete cascade,
  customer_id     uuid not null references customers (id) on delete cascade,
  product_id      uuid not null references products (id) on delete cascade,
  conversation_id uuid references conversations (id) on delete set null,
  status          text not null default 'waiting' check (status in ('waiting', 'notified', 'converted', 'expired')),
  created_at      timestamptz not null default now(),
  notified_at     timestamptz,
  unique (customer_id, product_id)
);

create index waitlist_status_idx on waitlist_entries (merchant_id, status);

-- ---------------------------------------------------------------------------
-- Money
-- ---------------------------------------------------------------------------

create table payment_links (
  id                     uuid primary key default gen_random_uuid(),
  merchant_id            uuid not null references merchants (id) on delete cascade,
  conversation_id        uuid references conversations (id) on delete set null,
  stripe_payment_link_id text,
  url                    text not null,
  amount_cents           int not null,
  line_items             jsonb not null default '[]'::jsonb,
  status                 text not null default 'created' check (status in ('created', 'paid', 'expired')),
  created_at             timestamptz not null default now(),
  paid_at                timestamptz
);

create table attributed_sales (
  id              uuid primary key default gen_random_uuid(),
  merchant_id     uuid not null references merchants (id) on delete cascade,
  payment_link_id uuid references payment_links (id) on delete set null,
  conversation_id uuid references conversations (id) on delete set null,
  amount_cents    int not null,
  source          text not null check (source in ('dm', 'comment', 'story_reply', 'revival', 'restock')),
  created_at      timestamptz not null default now()
);

create unique index attributed_sales_payment_link_idx
  on attributed_sales (payment_link_id)
  where payment_link_id is not null;

-- ---------------------------------------------------------------------------
-- Operator agent and observability
-- ---------------------------------------------------------------------------

create table operator_tasks (
  id             uuid primary key default gen_random_uuid(),
  merchant_id    uuid not null references merchants (id) on delete cascade,
  request        text not null,
  interpretation text,                                   -- what the agent understood
  action_type    text not null check (action_type in ('query', 'one_off', 'rule', 'correction')),
  payload        jsonb not null default '{}'::jsonb,
  status         text not null default 'pending_confirm' check (status in ('pending_confirm', 'approved', 'executed', 'rejected')),
  created_at     timestamptz not null default now(),
  executed_at    timestamptz
);

create index operator_tasks_merchant_status_idx on operator_tasks (merchant_id, status);

create table event_log (
  id          uuid primary key default gen_random_uuid(),
  merchant_id uuid references merchants (id) on delete cascade,
  kind        text not null,
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index event_log_merchant_kind_idx on event_log (merchant_id, kind, created_at desc);

-- Provider webhook delivery is at-least-once; the event id is the dedupe key.
create table webhook_events (
  event_id     text primary key,
  provider     text not null,
  processed_at timestamptz not null default now()
);

-- Durable counter behind the rate limits and daily caps enforced in code (§1.7, §4.6).
create table send_log (
  id          uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants (id) on delete cascade,
  kind        text not null check (kind in ('reply', 'private_reply', 'revival', 'restock', 'operator_batch')),
  customer_id uuid references customers (id) on delete set null,
  created_at  timestamptz not null default now()
);

create index send_log_merchant_kind_created_idx on send_log (merchant_id, kind, created_at desc);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

-- Resolves the calling user to their merchant row. `security definer` so the
-- lookup itself is not subject to the policies it is used by.
create or replace function public.current_merchant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from merchants where auth_user_id = auth.uid()
$$;

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from platform_admins where auth_user_id = auth.uid())
$$;

alter table merchants        enable row level security;
alter table platform_admins  enable row level security;
alter table connections      enable row level security;
alter table agent_configs    enable row level security;
alter table skills           enable row level security;
alter table customers        enable row level security;
alter table conversations    enable row level security;
alter table messages         enable row level security;
alter table products         enable row level security;
alter table waitlist_entries enable row level security;
alter table payment_links    enable row level security;
alter table attributed_sales enable row level security;
alter table operator_tasks   enable row level security;
alter table event_log        enable row level security;
alter table webhook_events   enable row level security;
alter table send_log         enable row level security;

-- Merchants see their own row; admins see all.
create policy merchants_select on merchants for select
  using (auth_user_id = auth.uid() or public.is_platform_admin());
create policy merchants_update on merchants for update
  using (auth_user_id = auth.uid());

create policy platform_admins_select on platform_admins for select
  using (public.is_platform_admin());

-- Every merchant-scoped table follows the same shape: read your own rows, or
-- everything if you are the founder. Writes go through the service-role client,
-- which bypasses RLS entirely, so no write policies are granted here.
do $$
declare
  t text;
begin
  foreach t in array array[
    'connections', 'agent_configs', 'customers', 'conversations',
    'products', 'waitlist_entries', 'payment_links', 'attributed_sales',
    'operator_tasks', 'event_log', 'send_log'
  ] loop
    execute format(
      'create policy %1$s_select on %1$I for select using (merchant_id = public.current_merchant_id() or public.is_platform_admin())',
      t
    );
  end loop;
end $$;

-- Skills: merchant-owned rows plus global skills (merchant_id is null).
create policy skills_select on skills for select
  using (merchant_id = public.current_merchant_id() or merchant_id is null or public.is_platform_admin());

-- Messages have no merchant_id; they inherit scope from their conversation.
create policy messages_select on messages for select
  using (
    exists (
      select 1 from conversations c
      where c.id = messages.conversation_id
        and (c.merchant_id = public.current_merchant_id() or public.is_platform_admin())
    )
  );

-- Internal bookkeeping. Service role only; no policy means no anon/authenticated access.
create policy webhook_events_admin on webhook_events for select using (public.is_platform_admin());
