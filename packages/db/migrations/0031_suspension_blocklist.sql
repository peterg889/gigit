-- Make a suspension survive the user deleting their own account.
--
-- Self-deactivation is deliberately allowed even while suspended: people get to
-- leave. But deactivation nulls email and phone, and auth/verify identifies a
-- returning user BY those identifiers — so a suspended user holding a valid
-- 30-day session cookie could DELETE /api/account and then sign up again on the
-- same address as a clean, active account. Suspension was self-erasable, and it
-- is the only moderation lever this product has.
--
-- Identifiers are stored hashed: the point of deactivation is that we stop
-- holding the address, and a blocklist that undoes that would trade one problem
-- for a worse one. A hash still answers the only question we need to ask —
-- "has this exact address been suspended before?"
create table if not exists blocked_identifiers (
  identifier_hash text primary key,
  reason text not null default 'suspended',
  blocked_at timestamptz not null default now(),
  source_user_id text references users(id)
);

comment on table blocked_identifiers is
  'Suspended identifiers, hashed. Consulted by auth/verify before creating a new account.';
