-- Where to reach the merchant when a draft is waiting (C4).
--
-- Suggest mode is the default, so almost every reply waits for her. Without a
-- notification she is slower than she was before Earlymark, which makes the core
-- claim false. Sent from Earlymark's own WhatsApp/Instagram account to hers.
--
-- notify_participant_id is her handle or phone number as the messaging provider
-- addresses it. Captured during onboarding, because Meta requires her to have
-- opened the conversation or accepted a template first.

alter table merchants
  add column notify_participant_id text,
  add column notified_at timestamptz;
