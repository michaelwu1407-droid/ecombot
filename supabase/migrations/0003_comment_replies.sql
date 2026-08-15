-- Meta allows exactly one private reply per comment, ever, within 7 days.
--
-- Webhook dedupe (webhook_events) stops the same *delivery* being processed twice,
-- but a comment can surface through more than one event, and a second private
-- reply is a hard API rejection — and, repeated, an account-standing problem.
-- The comment id is the durable key, so it gets its own table.

create table comment_replies (
  comment_id      text primary key,
  merchant_id     uuid not null references merchants (id) on delete cascade,
  conversation_id uuid references conversations (id) on delete set null,
  post_id         text,
  /* pending | replied | skipped_no_intent | skipped_window | failed */
  outcome         text not null default 'pending',
  created_at      timestamptz not null default now()
);

create index comment_replies_merchant_created_idx
  on comment_replies (merchant_id, created_at desc);

alter table comment_replies enable row level security;

create policy comment_replies_select on comment_replies for select
  using (merchant_id = public.current_merchant_id() or public.is_platform_admin());
