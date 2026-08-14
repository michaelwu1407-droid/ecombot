-- Outbound messages need a state, because not every draft is sent.
--
-- Suggest mode (§3.4) is the default: the agent drafts and the merchant approves.
-- A guardrail-blocked reply is also never silently dropped (§4.4) — it is kept and
-- escalated. Both need somewhere to live, and the transcript is the right place:
-- the escalations queue is then a view over the conversation, not a parallel store.

alter table messages
  add column status text not null default 'sent'
    check (status in ('sent', 'pending_approval', 'blocked', 'dismissed')),
  add column blocked_reason text,
  add column approved_at timestamptz;

-- The escalations queue reads this: everything waiting on the merchant.
create index messages_pending_idx
  on messages (conversation_id, created_at desc)
  where status in ('pending_approval', 'blocked');
