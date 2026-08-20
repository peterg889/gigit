-- A party must consent before it is made to pay.
--
-- A sound job names who funds it, and until now either booking party could post
-- one naming the OTHER as payer: an act could post payer='venue' and the venue
-- first heard about the bill from its own booking page. Money is off, so nothing
-- moved — but the obligation, and the notice telling the venue it owed a tech,
-- were both created without the venue ever agreeing.
--
-- A job posted by someone other than its named payer now starts in
-- 'awaiting_payer' and reaches no tech until that payer accepts. Posted BY the
-- payer it still starts 'open', because posting it IS consent.
--
-- 'awaiting_payer' has to join this partial unique index. The pending proposal
-- already holds the booking's single sound slot: if the predicate did not cover
-- it, one booking could carry a pending proposal AND a live job at once, and
-- createTechSubslot's own ACTIVE_SUBSLOT_STATES guard (which does cover it)
-- would reject a second job that this index was still happy to store. The two
-- must name the same set or the guard and the backstop disagree about what
-- "already has a sound job" means.
--
-- No remediation block, unlike 0030: no row anywhere can already hold a state
-- that did not exist until this migration, so widening the predicate can only
-- ever ADD rows to the index — and every booking is already limited to one
-- ('open','booked') row by the index being replaced. A conflict is arithmetically
-- impossible, so there is nothing for an operator to reconcile.
DROP INDEX IF EXISTS "tech_subslots_active_booking_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX "tech_subslots_active_booking_uq"
  ON "tech_subslots" USING btree ("booking_id")
  WHERE state IN ('awaiting_payer', 'open', 'booked');
--> statement-breakpoint

comment on column tech_subslots.state is
  'awaiting_payer (proposed, not yet consented to) | open | booked | released | cancelled_by_payer | cancelled_with_parent | declined_by_payer (payer refused the bill) | withdrawn_by_proposer.';
