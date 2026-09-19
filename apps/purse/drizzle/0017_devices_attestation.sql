CREATE TABLE "user_devices" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"key_id" text NOT NULL,
	"algorithm" text DEFAULT 'ES256' NOT NULL,
	"public_key" jsonb NOT NULL,
	"label" text,
	"created_by" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_devices_id_prefix" CHECK ("user_devices"."id" ~ '^udv_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "user_devices_user_id_prefix" CHECK ("user_devices"."user_id" ~ '^usr_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "user_devices_key_id_shape" CHECK ("user_devices"."key_id" ~ '^[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "user_devices_algorithm" CHECK ("user_devices"."algorithm" in ('ES256')),
	CONSTRAINT "user_devices_label_length" CHECK ("user_devices"."label" is null or length("user_devices"."label") <= 120),
	CONSTRAINT "user_devices_revoked_pair" CHECK (("user_devices"."revoked_at" is null) = ("user_devices"."revoked_by" is null)),
	CONSTRAINT "user_devices_revoked_reason_length" CHECK ("user_devices"."revoked_reason" is null or length("user_devices"."revoked_reason") <= 500)
);
--> statement-breakpoint
ALTER TABLE "contest_scores" ADD COLUMN "attestation_state" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "contest_scores" ADD COLUMN "attestation" jsonb;--> statement-breakpoint
ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_devices_live_key" ON "user_devices" USING btree ("user_id","key_id") WHERE "user_devices"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "user_devices_user_id_idx" ON "user_devices" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "contest_scores" ADD CONSTRAINT "contest_scores_attestation_state" CHECK ("contest_scores"."attestation_state" in ('none', 'verified', 'unverified'));--> statement-breakpoint
ALTER TABLE "contest_scores" ADD CONSTRAINT "contest_scores_attestation_pair" CHECK (("contest_scores"."attestation_state" = 'none') = ("contest_scores"."attestation" is null));