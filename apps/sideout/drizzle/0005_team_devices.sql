CREATE TABLE "team_devices" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"user_id" text NOT NULL,
	"key_id" text NOT NULL,
	"algorithm" text DEFAULT 'ES256' NOT NULL,
	"public_key" jsonb NOT NULL,
	"purse_device_id" text,
	"purse_mirrored_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" text,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_devices_id_prefix" CHECK ("team_devices"."id" ~ '^dev_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "team_devices_key_id_shape" CHECK ("team_devices"."key_id" ~ '^[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "team_devices_algorithm" CHECK ("team_devices"."algorithm" in ('ES256')),
	CONSTRAINT "team_devices_revoked_pair" CHECK (("team_devices"."revoked_at" IS NULL) = ("team_devices"."revoked_by_user_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "score_submissions" ADD COLUMN "attestation" jsonb;--> statement-breakpoint
ALTER TABLE "team_devices" ADD CONSTRAINT "team_devices_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_devices" ADD CONSTRAINT "team_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_devices" ADD CONSTRAINT "team_devices_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "team_devices_live_key" ON "team_devices" USING btree ("team_id","key_id") WHERE "team_devices"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "team_devices_team_idx" ON "team_devices" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "team_devices_user_idx" ON "team_devices" USING btree ("user_id");