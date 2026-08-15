-- Three-stage comment filter and its training log (BUILD_SPEC §4.11, §4.13).
--
-- `comment_events` supersedes `comment_replies`. Same primary key, so it keeps the
-- claim-before-you-reply property that stops two concurrent deliveries both
-- answering the same comment — Meta allows exactly one private reply per comment,
-- ever. What it adds is a row for **every comment seen**, including the ~85% we do
-- not answer.
--
-- That matters for one reason, and it cannot be fixed later: a classifier trained
-- only on comments we chose to reply to learns to agree with its own past
-- decisions, and narrows until it catches nothing but the obvious. The `exploration`
-- flag is the fix — a random 5% of low-confidence comments get answered anyway, and
-- their outcomes are the only unbiased signal in the whole table.

create table comment_events (
  comment_id             text primary key,
  merchant_id            uuid not null references merchants (id) on delete cascade,
  post_id                text,
  comment_text           text,
  commenter_platform_id  text,

  /* 1 = discarded by rules, 2 = passed by pattern match, 3 = decided by the model */
  filter_stage           int,
  classifier_confidence  double precision,

  replied                boolean not null default false,
  /* Answered *despite* a low score, sampled at random. The unbiased rows. */
  exploration            boolean not null default false,

  /* pending | replied | skipped_no_intent | skipped_window | skipped_capped | failed */
  outcome                text not null default 'pending',

  conversation_id        uuid references conversations (id) on delete set null,
  converted              boolean not null default false,
  revenue_cents          int not null default 0,

  created_at             timestamptz not null default now()
);

create index comment_events_merchant_created_idx
  on comment_events (merchant_id, created_at desc);

-- The training query: labelled rows, with the exploration sample called out.
create index comment_events_training_idx
  on comment_events (merchant_id, replied, converted);

-- A claim that was never resolved means the run died mid-flight. Swept hourly so a
-- lead is not lost in silence.
create index comment_events_pending_idx
  on comment_events (created_at)
  where outcome = 'pending';

alter table comment_events enable row level security;

create policy comment_events_select on comment_events for select
  using (merchant_id = public.current_merchant_id() or public.is_platform_admin());

-- Carry across anything already claimed, then retire the old table.
insert into comment_events (comment_id, merchant_id, post_id, conversation_id, outcome, replied, created_at)
select comment_id, merchant_id, post_id, conversation_id, outcome, outcome = 'replied', created_at
from comment_replies
on conflict (comment_id) do nothing;

drop table comment_replies;

-- Rate discipline (§4.11): never send the same words twice from one account.
-- A hash rather than the text so the index stays small.
alter table send_log
  add column text_hash text;

create index send_log_text_hash_idx
  on send_log (merchant_id, text_hash)
  where text_hash is not null;

-- A shopper who asked to be left alone is left alone, permanently.
alter table customers
  add column opted_out_at timestamptz;
