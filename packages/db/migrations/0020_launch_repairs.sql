-- Repair the application reset shipped in 0017: its NOT EXISTS only recognized
-- bookings still in 'offered', so the winning performer's application on any
-- booking that had advanced past 'offered' was flipped back to 'submitted'
-- (venue saw a "send offer" form for the act it already booked; the performer's
-- accepted gig regressed to "pending"). Restore those applications to
-- 'offered'; the pairing is unambiguous because a booking row for a
-- (slot, performer) pair is only ever created from that application.
UPDATE applications AS application
SET status = 'offered'
WHERE application.status = 'submitted'
  AND EXISTS (
    SELECT 1
    FROM bookings AS booking
    WHERE booking.slot_id = application.slot_id
      AND booking.performer_id = application.performer_id
      AND booking.state IN (
        'confirming',
        'confirmed',
        'awaiting_confirmation',
        'disputed',
        'released',
        'partially_released'
      )
  );
--> statement-breakpoint
-- Metro matching became lowercase-only (metroSchema lowercases new writes and
-- search queries) with no backfill, so mixed-case legacy rows became
-- unfindable and saved-search/home-metro matching silently stopped firing.
UPDATE performers SET home_metro = lower(home_metro) WHERE home_metro <> lower(home_metro);
--> statement-breakpoint
UPDATE venues SET metro = lower(metro) WHERE metro <> lower(metro);
--> statement-breakpoint
UPDATE slots SET metro = lower(metro) WHERE metro <> lower(metro);
--> statement-breakpoint
UPDATE slot_series SET metro = lower(metro) WHERE metro <> lower(metro);
--> statement-breakpoint
UPDATE saved_searches SET metro = lower(metro) WHERE metro IS NOT NULL AND metro <> lower(metro);
--> statement-breakpoint
-- Venues in metros without a known centroid were pinned at (0,0) — a point in
-- the Gulf of Guinea — so every radius-filtered search silently excluded their
-- slots. Coordinates become nullable ("location unknown"); the slots feed
-- keeps null-coordinate venues visible instead of hiding them.
ALTER TABLE venues ALTER COLUMN lat DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE venues ALTER COLUMN lng DROP NOT NULL;
--> statement-breakpoint
UPDATE venues SET lat = NULL, lng = NULL WHERE lat = 0 AND lng = 0;
--> statement-breakpoint
-- The public support rate limiter counted events rows via an unindexed JSON
-- payload key. Store the request IP on the support request itself, indexed
-- like auth_otps (auth_otps_ip_idx), and backfill from the event payloads so
-- the rolling window survives the cutover.
ALTER TABLE support_requests ADD COLUMN request_ip text;
--> statement-breakpoint
UPDATE support_requests sr
SET request_ip = e.payload->>'requestIp'
FROM events e
WHERE e.subject_type = 'support_request'
  AND e.subject_id = sr.id
  AND e.payload->>'requestIp' IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "support_requests_ip_idx" ON "support_requests" USING btree ("request_ip","created_at");
--> statement-breakpoint
CREATE INDEX "support_requests_created_idx" ON "support_requests" USING btree ("created_at");
