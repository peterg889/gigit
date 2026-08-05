-- One profile of each kind per account, enforced by the database.
--
-- The three create routes did check-then-insert with no constraint behind it, so
-- two concurrent POSTs both passed the guard and both inserted. After that,
-- `performerOwnedBy` (a bare `rows[0]` with no ordering) returned a
-- nondeterministic winner per request — media attached to one profile, the page
-- rendered the other, and ownership checks flipped between them.
--
-- Repair the legacy shape before adding the constraint. The ownership loaders
-- have always treated the oldest profile as canonical; preserve that behavior
-- deterministically (ID breaks the extremely unlikely created_at tie) and hide
-- the remaining live rows. Keep the lock through index creation so an old app
-- process cannot insert another duplicate between the repair and constraint.
lock table performers, venues, techs in share row exclusive mode;

with ranked as (
  select id,
         row_number() over (
           partition by owner_user_id order by created_at, id
         ) as owner_rank
    from performers
   where status = 'live'
)
update performers p
   set status = 'hidden'
  from ranked r
 where p.id = r.id and r.owner_rank > 1;

with ranked as (
  select id,
         row_number() over (
           partition by owner_user_id order by created_at, id
         ) as owner_rank
    from venues
   where status = 'live'
)
update venues v
   set status = 'hidden'
  from ranked r
 where v.id = r.id and r.owner_rank > 1;

with ranked as (
  select id,
         row_number() over (
           partition by owner_user_id order by created_at, id
         ) as owner_rank
    from techs
   where status = 'live'
)
update techs t
   set status = 'hidden'
  from ranked r
 where t.id = r.id and r.owner_rank > 1;

-- Partial so deactivated and demoted legacy rows can be retained for history;
-- only the single public live profile participates in the constraint.
create unique index if not exists performers_owner_uq
  on performers (owner_user_id) where status = 'live';
create unique index if not exists venues_owner_uq
  on venues (owner_user_id) where status = 'live';
create unique index if not exists techs_owner_uq
  on techs (owner_user_id) where status = 'live';
