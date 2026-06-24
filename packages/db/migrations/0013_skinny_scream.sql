ALTER TABLE "events" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "dead_lettered_at" timestamp with time zone;