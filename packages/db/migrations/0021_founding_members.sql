-- Founding-Member tracking: durable signup rank per side (acts, venues) so the
-- "first 500 never pay a membership fee" promise can be honored at billing time.
ALTER TABLE performers ADD COLUMN founding_number integer;
--> statement-breakpoint
ALTER TABLE performers ADD COLUMN founding_member boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE venues ADD COLUMN founding_number integer;
--> statement-breakpoint
ALTER TABLE venues ADD COLUMN founding_member boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- Backfill existing profiles in signup order (created_at, then id as a stable
-- tiebreak). The first 500 of each side become Founding Members.
UPDATE performers p
SET founding_number = r.rn,
    founding_member = (r.rn <= 500)
FROM (
  SELECT id, row_number() OVER (ORDER BY created_at ASC, id ASC) AS rn
  FROM performers
) r
WHERE p.id = r.id;
--> statement-breakpoint
UPDATE venues v
SET founding_number = r.rn,
    founding_member = (r.rn <= 500)
FROM (
  SELECT id, row_number() OVER (ORDER BY created_at ASC, id ASC) AS rn
  FROM venues
) r
WHERE v.id = r.id;
--> statement-breakpoint
-- One rank per side (defends the invariant even if the app path is bypassed).
CREATE UNIQUE INDEX "performers_founding_number_uq" ON "performers" ("founding_number");
--> statement-breakpoint
CREATE UNIQUE INDEX "venues_founding_number_uq" ON "venues" ("founding_number");
