ALTER TABLE "auth_otps" ADD COLUMN "request_ip" text;--> statement-breakpoint
CREATE INDEX "auth_otps_ip_idx" ON "auth_otps" USING btree ("request_ip","created_at");--> statement-breakpoint
CREATE INDEX "auth_otps_created_idx" ON "auth_otps" USING btree ("created_at");