-- Linking an Instagram shopper to a Shopify customer.
--
-- The positioning (§1.8) is that every one of her 3,000 customers gets treated like
-- her best regular. Seeding from past Shopify orders is what makes that true on day
-- one — except Shopify knows a customer as an *email* and Instagram gives us a
-- *username*, and nothing joins them. A regular who has spent $2,000 gets greeted
-- as a stranger.
--
-- Four tiers, and the shape is the same as everything else here: certain joins
-- happen silently, likely joins get proposed, nothing is ever guessed.
--
--   1. The handle is already in Shopify — boutiques who sell in DMs routinely write
--      "IG: @sarah_c" into an order note. Unambiguous, and free.
--   2. Email at checkout — certain, but only after they buy through us.
--   3. A proposed match, one tap — she is the one person who actually knows.
--   4. The conversation — the agent may ask, and memory extraction records it.
--
-- Never a silent fuzzy merge on name. Telling one shopper about another shopper's
-- orders, from the merchant's own account, is not a bug you recover from.

-- A customer can now exist before we have ever seen them on Instagram: seeded from
-- Shopify with an email and no platform id.
alter table customers
  alter column platform_user_id drop not null;

alter table customers
  add column email text,
  add column shopify_customer_id text,
  add column first_seen_source text default 'instagram'
    check (first_seen_source in ('instagram', 'shopify'));

-- The original unique constraint assumed platform_user_id was always present.
alter table customers drop constraint customers_merchant_id_platform_user_id_key;

create unique index customers_platform_idx
  on customers (merchant_id, platform_user_id)
  where platform_user_id is not null;

create unique index customers_email_idx
  on customers (merchant_id, lower(email))
  where email is not null;

create unique index customers_shopify_idx
  on customers (merchant_id, shopify_customer_id)
  where shopify_customer_id is not null;

-- Tier 3: a likely match, waiting for her one tap. She sees only her own data on
-- both sides, and her answer is certain where an algorithm's guess is not.
create table customer_match_proposals (
  id                   uuid primary key default gen_random_uuid(),
  merchant_id          uuid not null references merchants (id) on delete cascade,
  /* The Instagram-side record. */
  customer_id          uuid not null references customers (id) on delete cascade,
  /* The Shopify-seeded record we think is the same person. */
  candidate_customer_id uuid not null references customers (id) on delete cascade,
  /* Why we think so, in her words. */
  evidence             text not null,
  status               text not null default 'pending'
                         check (status in ('pending', 'accepted', 'rejected')),
  created_at           timestamptz not null default now(),
  resolved_at          timestamptz,
  unique (customer_id, candidate_customer_id)
);

create index customer_match_pending_idx
  on customer_match_proposals (merchant_id, created_at desc)
  where status = 'pending';

alter table customer_match_proposals enable row level security;

create policy customer_match_proposals_select on customer_match_proposals for select
  using (merchant_id = public.current_merchant_id() or public.is_platform_admin());
