-- Fixes for three ways the agent could act in front of a customer when it should not.
--
-- C3 — the merchant answers in the Instagram app and the agent talks over her.
-- Her sends arrive as ordinary outbound events, indistinguishable from ours except
-- that ours were recorded here first. When she takes over, the agent stands down on
-- that thread until the shopper writes again.
alter table conversations
  add column merchant_took_over_at timestamptz;

-- C5 — a second inbound message used to produce a second, independent draft that
-- could not see the first. A superseded draft is kept rather than deleted so the
-- merchant's approvals list has an honest history.
alter table messages
  drop constraint messages_status_check;

alter table messages
  add constraint messages_status_check
    check (status in ('sent', 'pending_approval', 'blocked', 'dismissed', 'superseded'));

-- The escalations queue reads pending work; a superseded draft is no longer pending.
drop index if exists messages_pending_idx;
create index messages_pending_idx
  on messages (conversation_id, created_at desc)
  where status in ('pending_approval', 'blocked');

-- H4 — "dismiss" used to abandon the shopper silently. Recording why lets the
-- founder health view surface threads nobody ever answered.
alter table messages
  add column dismiss_reason text;
