-- A booking owns one shared conversation. Before this constraint, the booking
-- page and at-least-once worker could both pass ensureBookingThread's initial
-- SELECT and create separate threads for the same booking.
--
-- Merge any legacy duplicates before enforcing the invariant. The oldest
-- thread remains canonical (ID breaks created_at ties); participants and
-- messages and thread-scoped audit events move to it before the redundant rows
-- are removed.
lock table threads, thread_participants, messages, events in share row exclusive mode;

with ranked as (
  select id,
         first_value(id) over (
           partition by scope, subject_id order by created_at, id
         ) as canonical_id
    from threads
   where scope = 'booking' and subject_id is not null
)
insert into thread_participants (thread_id, user_id)
select distinct r.canonical_id, p.user_id
  from ranked r
  join thread_participants p on p.thread_id = r.id
 where r.id <> r.canonical_id
on conflict (thread_id, user_id) do nothing;

with ranked as (
  select id,
         first_value(id) over (
           partition by scope, subject_id order by created_at, id
         ) as canonical_id
    from threads
   where scope = 'booking' and subject_id is not null
)
update messages m
   set thread_id = r.canonical_id
  from ranked r
 where m.thread_id = r.id and r.id <> r.canonical_id;

with ranked as (
  select id,
         first_value(id) over (
           partition by scope, subject_id order by created_at, id
         ) as canonical_id
    from threads
   where scope = 'booking' and subject_id is not null
)
update events e
   set subject_id = r.canonical_id
  from ranked r
 where e.subject_type = 'thread'
   and e.subject_id = r.id
   and r.id <> r.canonical_id;

with ranked as (
  select id,
         first_value(id) over (
           partition by scope, subject_id order by created_at, id
         ) as canonical_id
    from threads
   where scope = 'booking' and subject_id is not null
)
delete from thread_participants p
 using ranked r
 where p.thread_id = r.id and r.id <> r.canonical_id;

with ranked as (
  select id,
         row_number() over (
           partition by scope, subject_id order by created_at, id
         ) as subject_rank
    from threads
   where scope = 'booking' and subject_id is not null
)
delete from threads t
 using ranked r
 where t.id = r.id and r.subject_rank > 1;

create unique index if not exists threads_booking_subject_uq
  on threads (scope, subject_id)
  where scope = 'booking' and subject_id is not null;
