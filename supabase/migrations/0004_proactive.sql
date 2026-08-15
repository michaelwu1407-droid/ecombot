-- Proactive sends need their own state, separate from the reply path.
--
-- A conversation gets one revival attempt, ever (§2.5 is "follow-up", not
-- "follow-ups"). Deriving that from the message log would mean inspecting JSON
-- on every sweep; a timestamp on the conversation is one indexed read.

alter table conversations
  add column revival_sent_at timestamptz;

create index conversations_revival_candidates_idx
  on conversations (merchant_id, status, last_message_at)
  where revival_sent_at is null and outcome is null;

-- A waitlist entry is notified once per restock, not once per sweep. notified_at
-- already exists; this index is what makes the hourly job cheap.
create index waitlist_waiting_idx
  on waitlist_entries (merchant_id, product_id)
  where status = 'waiting';
