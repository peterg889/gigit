ALTER TABLE "venues" ADD COLUMN "address_line1" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN "address_line2" text;--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN "city" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN "region" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN "postal_code" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN "time_zone" text DEFAULT 'UTC' NOT NULL;
