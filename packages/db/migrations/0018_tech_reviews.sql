CREATE TABLE "tech_subslot_reviews" (
  "id" text PRIMARY KEY NOT NULL,
  "subslot_id" text NOT NULL,
  "author_role" text NOT NULL,
  "ratings" jsonb NOT NULL,
  "body" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "tech_subslot_reviews" ADD CONSTRAINT "tech_subslot_reviews_subslot_id_tech_subslots_id_fk" FOREIGN KEY ("subslot_id") REFERENCES "public"."tech_subslots"("id") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "tech_subslot_reviews_author_uq" ON "tech_subslot_reviews" USING btree ("subslot_id","author_role");
