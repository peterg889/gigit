CREATE TABLE "support_request_notes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"support_request_id" text NOT NULL,
	"author_user_id" text NOT NULL,
	"kind" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"requester_user_id" text,
	"contact_email" text,
	"contact_phone" text,
	"channel" text NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"escalation_reason" text NOT NULL,
	"message" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"claimed_by_user_id" text,
	"claimed_at" timestamp with time zone,
	"resolved_by_user_id" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "support_request_notes" ADD CONSTRAINT "support_request_notes_support_request_id_support_requests_id_fk" FOREIGN KEY ("support_request_id") REFERENCES "public"."support_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_request_notes" ADD CONSTRAINT "support_request_notes_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_claimed_by_user_id_users_id_fk" FOREIGN KEY ("claimed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_request_notes_request_idx" ON "support_request_notes" USING btree ("support_request_id","created_at");--> statement-breakpoint
CREATE INDEX "support_requests_queue_idx" ON "support_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "support_requests_requester_idx" ON "support_requests" USING btree ("requester_user_id","created_at");--> statement-breakpoint
INSERT INTO "support_requests" (
	"id",
	"requester_user_id",
	"contact_email",
	"contact_phone",
	"channel",
	"category",
	"escalation_reason",
	"message",
	"created_at"
)
SELECT
	'spr_legacy_' || e."id"::text,
	u."id",
	coalesce(nullif(e."payload"->>'email', ''), u."email"),
	u."phone",
	CASE WHEN e."payload"->>'channel' = 'sms' THEN 'sms' ELSE 'web' END,
	CASE
		WHEN coalesce(e."payload"->>'category', '') IN ('', 'public') THEN 'other'
		ELSE e."payload"->>'category'
	END,
	'legacy',
	coalesce(
		nullif(e."payload"->>'message', ''),
		nullif(e."payload"->>'body', ''),
		'Legacy support escalation; original message unavailable.'
	),
	e."occurred_at"
FROM "events" e
LEFT JOIN "users" u ON u."id" = CASE
	WHEN e."actor" LIKE 'usr_%' THEN e."actor"
	WHEN e."subject_type" = 'user' THEN e."subject_id"
	ELSE NULL
END
WHERE e."kind" = 'support.escalated'
ON CONFLICT ("id") DO NOTHING;
