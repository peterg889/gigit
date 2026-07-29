-- Distinguish "passed over when the slot filled" from "the venue declined you",
-- and record who opened an inquiry thread.
--
-- 1. `declined` conflated both cases, so when a confirmed booking was cancelled
--    the slot reopened but its whole warm applicant pool stayed frozen: they
--    couldn't re-apply (unique index on (slot_id, performer_id) → 409), the
--    venue couldn't offer them (createOffer requires 'submitted'), and series
--    re-book skipped the night forever. The night could only be filled by an
--    act that had never applied.
alter table applications
  add column if not exists decline_reason text;

-- Backfill: existing declines are indistinguishable, so treat them as venue
-- decisions. That's the conservative reading — it leaves them inactive rather
-- than resurrecting applications a venue may have deliberately turned down.
update applications set decline_reason = 'venue_declined'
 where status = 'declined' and decline_reason is null;

create index if not exists applications_slot_reason_idx
  on applications (slot_id, status, decline_reason);

-- 2. The daily inquiry cap counted rows where the user was a *participant*,
--    which includes threads other people opened with them. A popular act that
--    received 10 inquiries was locked out of sending any of its own, and it
--    never cleared while the inbox stayed busy.
alter table threads
  add column if not exists created_by_user_id text references users(id);

create index if not exists threads_author_idx
  on threads (created_by_user_id, scope, created_at);
