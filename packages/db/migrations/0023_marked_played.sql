-- Record the act's own "I played it" claim.
--
-- PERFORMER_MARKED_PLAYED was a pure no-op: same state, no effects, nothing
-- persisted. So the button gave no feedback, re-pressing it appended another
-- transition row, and the venue was never told the night was waiting on them.
-- Release happened only via the 24h auto-confirm, making the act's click
-- indistinguishable from never clicking.
alter table bookings add column if not exists performer_marked_played_at timestamptz;
