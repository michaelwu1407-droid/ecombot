-- The self-learning loop (BUILD_SPEC §4.12).
--
-- Month 1 is a generic agent in her voice. Month 6 knows her policies, quirks,
-- exceptions and customers. A competitor starts at month 1 and cannot buy month 6.
--
-- The mechanism is her edits. Every time she rewrites a draft before sending, she
-- is teaching — and until now that signal went into event_log and died there.

create table draft_corrections (
  id              uuid primary key default gen_random_uuid(),
  merchant_id     uuid not null references merchants (id) on delete cascade,
  conversation_id uuid references conversations (id) on delete set null,
  /* sizing | shipping | price | availability | policy | other */
  question_type   text not null default 'other',
  agent_draft     text not null,
  /* Null when she rejected the draft outright — a negative example, not a rewrite. */
  merchant_version text,
  context         jsonb not null default '{}'::jsonb,
  /* Set once a correction has contributed to a proposal, so it is not counted twice. */
  used_at         timestamptz,
  created_at      timestamptz not null default now()
);

create index draft_corrections_pattern_idx
  on draft_corrections (merchant_id, question_type, created_at desc)
  where used_at is null and merchant_version is not null;

create table skill_proposals (
  id                      uuid primary key default gen_random_uuid(),
  merchant_id             uuid not null references merchants (id) on delete cascade,
  question_type           text not null,
  /* The one sentence she reads. */
  proposed_content        text not null,
  evidence_correction_ids uuid[] not null default '{}',
  status                  text not null default 'pending'
                            check (status in ('pending', 'accepted', 'rejected')),
  created_at              timestamptz not null default now(),
  resolved_at             timestamptz
);

create index skill_proposals_pending_idx
  on skill_proposals (merchant_id, created_at desc)
  where status = 'pending';

-- A rejected pattern is not re-proposed for 30 days. Being asked the same question
-- every week is its own kind of failure.
create index skill_proposals_recent_idx
  on skill_proposals (merchant_id, question_type, resolved_at desc);

alter table draft_corrections enable row level security;
alter table skill_proposals   enable row level security;

create policy draft_corrections_select on draft_corrections for select
  using (merchant_id = public.current_merchant_id() or public.is_platform_admin());

create policy skill_proposals_select on skill_proposals for select
  using (merchant_id = public.current_merchant_id() or public.is_platform_admin());
