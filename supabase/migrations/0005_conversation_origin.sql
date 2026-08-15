-- A conversation that began as a comment can only be opened one way.
--
-- Instagram does not permit an unsolicited DM to someone who has never messaged
-- the shop. The private-reply-to-comment endpoint is the one legal route, and it
-- needs the comment and post ids. Without them stored, a draft that waits in the
-- approvals queue would be sent as a plain DM when the merchant taps send — and
-- rejected, silently losing the lead the comment earned.

alter table conversations
  add column origin_comment_id text,
  add column origin_post_id text;
