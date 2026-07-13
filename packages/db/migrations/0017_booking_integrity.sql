WITH ranked AS (
  SELECT id
  FROM (
    SELECT
      id,
      slot_id,
      row_number() OVER (
        PARTITION BY slot_id
        ORDER BY created_at ASC, id ASC
      ) AS position
    FROM bookings
    WHERE state = 'offered'
  ) offers
  WHERE position > 1
     OR EXISTS (
       SELECT 1
       FROM bookings AS engaged
       WHERE engaged.slot_id = offers.slot_id
         AND engaged.state IN (
           'confirming',
           'confirmed',
           'awaiting_confirmation',
           'disputed',
           'released',
           'partially_released'
         )
     )
)
UPDATE bookings
SET state = 'collapsed', version = version + 1
WHERE id IN (SELECT id FROM ranked);
--> statement-breakpoint
UPDATE applications AS application
SET status = 'submitted'
WHERE application.status = 'offered'
  AND NOT EXISTS (
    SELECT 1
    FROM bookings AS booking
    WHERE booking.slot_id = application.slot_id
      AND booking.performer_id = application.performer_id
      AND booking.state = 'offered'
  );
--> statement-breakpoint
DROP INDEX "bookings_active_slot_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_active_slot_uq" ON "bookings" USING btree ("slot_id") WHERE state in ('offered','confirming','confirmed','awaiting_confirmation','disputed','released','partially_released');
