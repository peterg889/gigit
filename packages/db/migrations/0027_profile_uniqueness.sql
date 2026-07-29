-- One profile of each kind per account, enforced by the database.
--
-- The three create routes did check-then-insert with no constraint behind it, so
-- two concurrent POSTs both passed the guard and both inserted. After that,
-- `performerOwnedBy` (a bare `rows[0]` with no ordering) returned a
-- nondeterministic winner per request — media attached to one profile, the page
-- rendered the other, and ownership checks flipped between them.
--
-- Partial, so a hidden profile from a deactivated account doesn't block the
-- owner from ever creating a fresh one if they come back.
create unique index if not exists performers_owner_uq
  on performers (owner_user_id) where status = 'live';
create unique index if not exists venues_owner_uq
  on venues (owner_user_id) where status = 'live';
create unique index if not exists techs_owner_uq
  on techs (owner_user_id) where status = 'live';
