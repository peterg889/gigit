-- Give the outbox retry budget a time dimension.
--
-- The claim query had no time predicate, and the poll only slept when a batch
-- came back empty — a failing row counts as "processed", so the loop re-claimed
-- it on the next iteration. All five attempts burned in ~50ms, which meant any
-- outage lasting more than about a second guaranteed a permanent dead-letter.
-- That is what made the `confirming` trap reachable and what makes retrying
-- notification failures safe to turn on.
alter table events add column if not exists next_attempt_at timestamptz not null default now();

-- The claim query filters on this now, so it belongs in the covering index.
drop index if exists events_outbox_idx;
create index if not exists events_outbox_idx on events (dispatched_at, next_attempt_at);
