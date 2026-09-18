CREATE TYPE "public"."webhook_delivery_status" AS ENUM('pending', 'delivered', 'failed', 'dead');--> statement-breakpoint
CREATE TYPE "public"."webhook_endpoint_status" AS ENUM('enabled', 'disabled');--> statement-breakpoint
CREATE TABLE "embed_signin_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"phone_e164" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embed_signin_codes_id_prefix" CHECK ("embed_signin_codes"."id" ~ '^sic_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "embed_signin_codes_phone_shape" CHECK ("embed_signin_codes"."phone_e164" ~ '^\+[1-9][0-9]{6,14}$'),
	CONSTRAINT "embed_signin_codes_hash_shape" CHECK ("embed_signin_codes"."code_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "embed_signin_codes_attempts_range" CHECK ("embed_signin_codes"."attempts" >= 0 and "embed_signin_codes"."attempts" <= 100),
	CONSTRAINT "embed_signin_codes_expires_after_created" CHECK ("embed_signin_codes"."expires_at" > "embed_signin_codes"."created_at")
);
--> statement-breakpoint
CREATE TABLE "tenant_origins" (
	"tenant_id" text NOT NULL,
	"origin" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_origins_pkey" PRIMARY KEY("tenant_id","origin"),
	CONSTRAINT "tenant_origins_origin_shape" CHECK ("tenant_origins"."origin" ~ '^https?://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$')
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"endpoint_id" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 8 NOT NULL,
	"status" "webhook_delivery_status" DEFAULT 'pending' NOT NULL,
	"response_status" integer,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"locked_until" timestamp with time zone,
	"locked_by" text,
	"replay_of" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_id_prefix" CHECK ("webhook_deliveries"."id" ~ '^whd_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "webhook_deliveries_event_id_prefix" CHECK ("webhook_deliveries"."event_id" ~ '^evt_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "webhook_deliveries_replay_of_prefix" CHECK ("webhook_deliveries"."replay_of" is null or "webhook_deliveries"."replay_of" ~ '^whd_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "webhook_deliveries_event_type_known" CHECK ("webhook_deliveries"."event_type" = any('{user.verification.updated,contest.opened,contest.locked,contest.settled,contest.voided,contest.entry.created,contest.entry.withdrawn,wallet.balance.changed}'::text[])),
	CONSTRAINT "webhook_deliveries_attempt_range" CHECK ("webhook_deliveries"."attempt" >= 0 and "webhook_deliveries"."attempt" <= "webhook_deliveries"."max_attempts" and "webhook_deliveries"."max_attempts" >= 1),
	CONSTRAINT "webhook_deliveries_delivered_at_iff_delivered" CHECK (("webhook_deliveries"."status" = 'delivered') = ("webhook_deliveries"."delivered_at" is not null)),
	CONSTRAINT "webhook_deliveries_response_status_range" CHECK ("webhook_deliveries"."response_status" is null or ("webhook_deliveries"."response_status" between 100 and 599)),
	CONSTRAINT "webhook_deliveries_lock_pair" CHECK (("webhook_deliveries"."locked_until" is null) = ("webhook_deliveries"."locked_by" is null))
);
--> statement-breakpoint
CREATE TABLE "webhook_delivery_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"delivery_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"response_status" integer,
	"error" text,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_delivery_attempts_delivery_id_attempt_key" UNIQUE("delivery_id","attempt"),
	CONSTRAINT "webhook_delivery_attempts_id_prefix" CHECK ("webhook_delivery_attempts"."id" ~ '^wha_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "webhook_delivery_attempts_attempt_positive" CHECK ("webhook_delivery_attempts"."attempt" >= 1),
	CONSTRAINT "webhook_delivery_attempts_response_status_range" CHECK ("webhook_delivery_attempts"."response_status" is null or ("webhook_delivery_attempts"."response_status" between 100 and 599)),
	CONSTRAINT "webhook_delivery_attempts_error_length" CHECK ("webhook_delivery_attempts"."error" is null or length("webhook_delivery_attempts"."error") <= 500),
	CONSTRAINT "webhook_delivery_attempts_duration_range" CHECK ("webhook_delivery_attempts"."duration_ms" >= 0),
	CONSTRAINT "webhook_delivery_attempts_finished_after_started" CHECK ("webhook_delivery_attempts"."finished_at" >= "webhook_delivery_attempts"."started_at")
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"url" text NOT NULL,
	"signing_secret" text NOT NULL,
	"subscribed_events" text[] NOT NULL,
	"status" "webhook_endpoint_status" DEFAULT 'enabled' NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_endpoints_id_prefix" CHECK ("webhook_endpoints"."id" ~ '^whe_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "webhook_endpoints_url_shape" CHECK ("webhook_endpoints"."url" ~ '^https?://[^[:space:]]+$' and length("webhook_endpoints"."url") <= 2000),
	CONSTRAINT "webhook_endpoints_secret_envelope" CHECK ("webhook_endpoints"."signing_secret" like 'enc:v1:%'),
	CONSTRAINT "webhook_endpoints_events_known" CHECK ("webhook_endpoints"."subscribed_events" <@ '{user.verification.updated,contest.opened,contest.locked,contest.settled,contest.voided,contest.entry.created,contest.entry.withdrawn,wallet.balance.changed}'::text[] and cardinality("webhook_endpoints"."subscribed_events") >= 1),
	CONSTRAINT "webhook_endpoints_description_length" CHECK ("webhook_endpoints"."description" is null or length("webhook_endpoints"."description") <= 200)
);
--> statement-breakpoint
ALTER TABLE "embed_signin_codes" ADD CONSTRAINT "embed_signin_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_origins" ADD CONSTRAINT "tenant_origins_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_replay_of_fk" FOREIGN KEY ("replay_of") REFERENCES "public"."webhook_deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_delivery_attempts" ADD CONSTRAINT "webhook_delivery_attempts_delivery_id_webhook_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."webhook_deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "embed_signin_codes_tenant_phone_created_idx" ON "embed_signin_codes" USING btree ("tenant_id","phone_e164","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_endpoint_event_key" ON "webhook_deliveries" USING btree ("endpoint_id","event_id") WHERE "webhook_deliveries"."replay_of" is null;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("next_attempt_at") WHERE "webhook_deliveries"."status" in ('pending', 'failed');--> statement-breakpoint
CREATE INDEX "webhook_deliveries_event_id_idx" ON "webhook_deliveries" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_tenant_id_created_at_idx" ON "webhook_deliveries" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_tenant_id_idx" ON "webhook_endpoints" USING btree ("tenant_id");