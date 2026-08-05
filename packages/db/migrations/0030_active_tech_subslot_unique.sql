-- One parent booking may accumulate sound-job history, but it must never have
-- two live selection rounds. Multiple booked assignments carry money, ledger,
-- application, and notification history that a schema migration cannot safely
-- invent or unwind, so stop and require an operator to reconcile those rows.
DO $migration$
DECLARE
  conflicting_booking_ids text;
BEGIN
  SELECT string_agg(booking_id, ', ' ORDER BY booking_id)
  INTO conflicting_booking_ids
  FROM (
    SELECT booking_id
    FROM tech_subslots
    WHERE state = 'booked'
    GROUP BY booking_id
    HAVING count(*) > 1
    ORDER BY booking_id
    LIMIT 20
  ) AS conflicts;

  IF conflicting_booking_ids IS NOT NULL THEN
    RAISE EXCEPTION
      '0030_active_tech_subslot_unique: multiple booked sound jobs require manual remediation for booking(s): %',
      conflicting_booking_ids
      USING
        ERRCODE = '23514',
        HINT = 'Reconcile each assignment, application, ledger entry, and notification before rerunning this migration.';
  END IF;
END
$migration$;

-- Open listings have no booked-tech or money side effects. If a booked job
-- exists it wins and every open duplicate closes; otherwise keep the oldest
-- open row, with lexical ID as the deterministic tie-breaker.
WITH ranked_open AS (
  SELECT
    open_subslot.id,
    EXISTS (
      SELECT 1
      FROM tech_subslots AS booked_subslot
      WHERE booked_subslot.booking_id = open_subslot.booking_id
        AND booked_subslot.state = 'booked'
    ) AS has_booked_assignment,
    row_number() OVER (
      PARTITION BY open_subslot.booking_id
      ORDER BY open_subslot.created_at, open_subslot.id
    ) AS position
  FROM tech_subslots AS open_subslot
  WHERE open_subslot.state = 'open'
),
closed AS (
  UPDATE tech_subslots AS subslot
  SET
    state = 'cancelled_by_payer',
    version = subslot.version + 1
  FROM ranked_open
  WHERE subslot.id = ranked_open.id
    AND (ranked_open.has_booked_assignment OR ranked_open.position > 1)
  RETURNING subslot.id
)
UPDATE tech_subslot_applications AS application
SET status = 'declined'
FROM closed
WHERE application.subslot_id = closed.id
  AND application.status = 'submitted';

CREATE UNIQUE INDEX "tech_subslots_active_booking_uq"
  ON "tech_subslots" USING btree ("booking_id")
  WHERE state IN ('open', 'booked');
