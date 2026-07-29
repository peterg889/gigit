-- Profile visibility: deactivating or suspending an account must take the
-- person's public presence down with it. `performers.status` already existed
-- (and the directory/search already filter on it) but nothing ever wrote a
-- non-live value; venues and techs had no status at all — so a deactivated
-- venue's full street address stayed published indefinitely.
ALTER TABLE venues ADD COLUMN status text NOT NULL DEFAULT 'live';
--> statement-breakpoint
ALTER TABLE techs ADD COLUMN status text NOT NULL DEFAULT 'live';
--> statement-breakpoint
-- Existing rows are live by definition (they were publicly listed already).
-- Profiles owned by an account that is already deleted/suspended are hidden to
-- close the gap retroactively.
UPDATE venues v SET status = 'hidden'
  FROM users u WHERE u.id = v.owner_user_id AND u.status IN ('deleted', 'suspended');
--> statement-breakpoint
UPDATE techs t SET status = 'hidden'
  FROM users u WHERE u.id = t.owner_user_id AND u.status IN ('deleted', 'suspended');
--> statement-breakpoint
UPDATE performers p SET status = 'hidden'
  FROM users u WHERE u.id = p.owner_user_id AND u.status IN ('deleted', 'suspended');
--> statement-breakpoint
CREATE INDEX "venues_status_idx" ON "venues" ("status");
--> statement-breakpoint
CREATE INDEX "techs_status_idx" ON "techs" ("status");
