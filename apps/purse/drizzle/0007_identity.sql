CREATE TYPE "public"."api_key_environment" AS ENUM('sandbox', 'live');--> statement-breakpoint
CREATE TYPE "public"."api_key_kind" AS ENUM('secret', 'publishable');--> statement-breakpoint
CREATE TYPE "public"."embed_flow" AS ENUM('identity', 'wallet', 'entry', 'rewards');--> statement-breakpoint
CREATE TYPE "public"."idempotency_scope" AS ENUM('service', 'http');--> statement-breakpoint
CREATE TYPE "public"."location_source" AS ENUM('ip', 'declared', 'provider');--> statement-breakpoint
CREATE TYPE "public"."operator_flag_kind" AS ENUM('duplicate_identity', 'collusion_signal', 'risk_review');--> statement-breakpoint
CREATE TYPE "public"."operator_flag_status" AS ENUM('open', 'reviewed', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."restriction_kind" AS ENUM('self_exclusion', 'cool_off', 'platform_block', 'velocity_lock');--> statement-breakpoint
CREATE TYPE "public"."verification_state" AS ENUM('unstarted', 'pending', 'verified', 'rejected');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" "api_key_kind" NOT NULL,
	"environment" "api_key_environment" NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"label" text,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_id_prefix" CHECK ("api_keys"."id" ~ '^key_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "api_keys_key_hash_argon2id" CHECK ("api_keys"."key_hash" like '$argon2id$%'),
	CONSTRAINT "api_keys_key_prefix_shape" CHECK ("api_keys"."key_prefix" ~ '^(sk|pk)_(sandbox|live)_[A-Za-z0-9]{8}$'
        and "api_keys"."key_prefix" like (case "api_keys"."kind" when 'secret' then 'sk_' else 'pk_' end) || "api_keys"."environment"::text || '_%'),
	CONSTRAINT "api_keys_scopes_known" CHECK ("api_keys"."scopes" <@ '{operator}'::text[] and ("api_keys"."kind" = 'secret' or cardinality("api_keys"."scopes") = 0)),
	CONSTRAINT "api_keys_label_length" CHECK ("api_keys"."label" is null or length("api_keys"."label") <= 100)
);
--> statement-breakpoint
CREATE TABLE "eligibility_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"contest_id" text NOT NULL,
	"ruleset_version" text NOT NULL,
	"allowed" boolean NOT NULL,
	"reasons" text[] NOT NULL,
	"required_action" text,
	"context" jsonb NOT NULL,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eligibility_decisions_id_prefix" CHECK ("eligibility_decisions"."id" ~ '^eld_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "eligibility_decisions_reasons_iff_refused" CHECK ("eligibility_decisions"."allowed" = (cardinality("eligibility_decisions"."reasons") = 0)),
	CONSTRAINT "eligibility_decisions_action_needs_refusal" CHECK ("eligibility_decisions"."required_action" is null or not "eligibility_decisions"."allowed")
);
--> statement-breakpoint
CREATE TABLE "embed_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"flow" "embed_flow" NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embed_tokens_id_prefix" CHECK ("embed_tokens"."id" ~ '^emb_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "embed_tokens_token_hash_shape" CHECK ("embed_tokens"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "embed_tokens_expires_after_created" CHECK ("embed_tokens"."expires_at" > "embed_tokens"."created_at")
);
--> statement-breakpoint
CREATE TABLE "identity_fingerprints" (
	"user_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_fingerprints_shape" CHECK ("identity_fingerprints"."fingerprint" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "operator_flags" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" "operator_flag_kind" NOT NULL,
	"subject" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"detail" jsonb NOT NULL,
	"status" "operator_flag_status" DEFAULT 'open' NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_flags_tenant_id_kind_dedupe_key_key" UNIQUE("tenant_id","kind","dedupe_key"),
	CONSTRAINT "operator_flags_id_prefix" CHECK ("operator_flags"."id" ~ '^flg_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "operator_flags_reviewed_pair" CHECK (("operator_flags"."status" = 'open') = ("operator_flags"."reviewed_at" is null) and ("operator_flags"."reviewed_at" is null) = ("operator_flags"."reviewed_by" is null))
);
--> statement-breakpoint
CREATE TABLE "rulesets" (
	"version" text PRIMARY KEY NOT NULL,
	"body" jsonb NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rulesets_version_shape" CHECK ("rulesets"."version" ~ '^[0-9]{4}\.[0-9]{1,2}\.[0-9]+$')
);
--> statement-breakpoint
CREATE TABLE "user_locations" (
	"user_id" text PRIMARY KEY NOT NULL,
	"region_code" text NOT NULL,
	"source" "location_source" NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_locations_region_code_shape" CHECK ("user_locations"."region_code" ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$'),
	CONSTRAINT "user_locations_confidence_range" CHECK ("user_locations"."confidence" >= 0 and "user_locations"."confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "user_restrictions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" "restriction_kind" NOT NULL,
	"reason" text,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"lifted_at" timestamp with time zone,
	"lifted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_restrictions_id_prefix" CHECK ("user_restrictions"."id" ~ '^rst_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "user_restrictions_ends_after_starts" CHECK ("user_restrictions"."ends_at" is null or "user_restrictions"."ends_at" > "user_restrictions"."starts_at"),
	CONSTRAINT "user_restrictions_lifted_pair" CHECK (("user_restrictions"."lifted_at" is null) = ("user_restrictions"."lifted_by" is null)),
	CONSTRAINT "user_restrictions_reason_length" CHECK ("user_restrictions"."reason" is null or length("user_restrictions"."reason") <= 500)
);
--> statement-breakpoint
CREATE TABLE "user_verification" (
	"user_id" text PRIMARY KEY NOT NULL,
	"state" "verification_state" DEFAULT 'unstarted' NOT NULL,
	"provider" text,
	"provider_ref" text,
	"verified_at" timestamp with time zone,
	"reverify_after" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_verification_provider_shape" CHECK ("user_verification"."provider" is null or "user_verification"."provider" ~ '^[a-z][a-z0-9_-]{0,63}$'),
	CONSTRAINT "user_verification_provider_ref_opaque" CHECK ("user_verification"."provider_ref" is null or "user_verification"."provider_ref" ~ '^[A-Za-z0-9._:-]{1,128}$'),
	CONSTRAINT "user_verification_verified_at_iff_verified" CHECK (("user_verification"."state" = 'verified') = ("user_verification"."verified_at" is not null)),
	CONSTRAINT "user_verification_reverify_needs_verified" CHECK ("user_verification"."reverify_after" is null or "user_verification"."verified_at" is not null),
	CONSTRAINT "user_verification_provider_once_started" CHECK (("user_verification"."state" = 'unstarted') = ("user_verification"."provider" is null))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"external_id" text NOT NULL,
	"display_name" text,
	"phone_e164" text,
	"date_of_birth" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_tenant_id_external_id_key" UNIQUE("tenant_id","external_id"),
	CONSTRAINT "users_id_prefix" CHECK ("users"."id" ~ '^usr_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "users_external_id_not_blank" CHECK (length(trim("users"."external_id")) > 0 and length("users"."external_id") <= 255),
	CONSTRAINT "users_display_name_length" CHECK ("users"."display_name" is null or (length(trim("users"."display_name")) > 0 and length("users"."display_name") <= 200)),
	CONSTRAINT "users_phone_e164_shape" CHECK ("users"."phone_e164" is null or "users"."phone_e164" ~ '^\+[1-9][0-9]{6,14}$')
);
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ALTER COLUMN "result" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "user_id" text;--> statement-breakpoint
-- Existing rows are the service layer's (phase 2); the default exists only to fill them and
-- is dropped again so every new row names its scope explicitly.
ALTER TABLE "idempotency_keys" ADD COLUMN "scope" "idempotency_scope" NOT NULL DEFAULT 'service';--> statement-breakpoint
ALTER TABLE "idempotency_keys" ALTER COLUMN "scope" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD COLUMN "response_status" integer;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD COLUMN "response_body" jsonb;--> statement-breakpoint
-- Backfill for a database migrated from phase 2, which holds wallets, entries, scores and
-- results for users that had no row (the users table did not exist). Each such user gets a
-- placeholder row, keyed `legacy:<id>`, so the foreign keys below can be added valid and
-- every wallet can name its owner; `pnpm db:seed` then completes the six seed users under
-- their stable ids. A data migration for consistency, not seed data: it creates nothing on
-- a fresh database.
INSERT INTO "users" ("id", "tenant_id", "external_id")
SELECT DISTINCT ON (owner.user_id) owner.user_id, owner.tenant_id, 'legacy:' || owner.user_id
FROM (
  SELECT a.owner_ref AS user_id, a.tenant_id FROM "accounts" a WHERE a.kind = 'user_wallet'
  UNION
  SELECT p.user_id, c.tenant_id FROM "contest_participants" p JOIN "contests" c ON c.id = p.contest_id
  UNION
  SELECT s.user_id, c.tenant_id FROM "contest_scores" s JOIN "contests" c ON c.id = s.contest_id
  UNION
  SELECT r.user_id, c.tenant_id FROM "contest_results" r JOIN "contests" c ON c.id = r.contest_id
) owner
WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = owner.user_id)
ORDER BY owner.user_id, owner.tenant_id;--> statement-breakpoint
INSERT INTO "user_verification" ("user_id")
SELECT u.id FROM "users" u WHERE NOT EXISTS (SELECT 1 FROM "user_verification" v WHERE v.user_id = u.id);--> statement-breakpoint
UPDATE "accounts" SET "user_id" = "owner_ref" WHERE "kind" = 'user_wallet' AND "user_id" IS NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eligibility_decisions" ADD CONSTRAINT "eligibility_decisions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eligibility_decisions" ADD CONSTRAINT "eligibility_decisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eligibility_decisions" ADD CONSTRAINT "eligibility_decisions_contest_id_contests_id_fk" FOREIGN KEY ("contest_id") REFERENCES "public"."contests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eligibility_decisions" ADD CONSTRAINT "eligibility_decisions_ruleset_version_rulesets_version_fk" FOREIGN KEY ("ruleset_version") REFERENCES "public"."rulesets"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embed_tokens" ADD CONSTRAINT "embed_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embed_tokens" ADD CONSTRAINT "embed_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_fingerprints" ADD CONSTRAINT "identity_fingerprints_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_fingerprints" ADD CONSTRAINT "identity_fingerprints_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_flags" ADD CONSTRAINT "operator_flags_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_locations" ADD CONSTRAINT "user_locations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_restrictions" ADD CONSTRAINT "user_restrictions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_verification" ADD CONSTRAINT "user_verification_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_key_prefix_idx" ON "api_keys" USING btree ("key_prefix");--> statement-breakpoint
CREATE INDEX "api_keys_tenant_id_idx" ON "api_keys" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "eligibility_decisions_user_id_created_at_idx" ON "eligibility_decisions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "eligibility_decisions_contest_id_idx" ON "eligibility_decisions" USING btree ("contest_id");--> statement-breakpoint
CREATE UNIQUE INDEX "embed_tokens_token_hash_key" ON "embed_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "embed_tokens_user_id_idx" ON "embed_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "identity_fingerprints_tenant_id_fingerprint_idx" ON "identity_fingerprints" USING btree ("tenant_id","fingerprint");--> statement-breakpoint
CREATE INDEX "operator_flags_tenant_id_status_idx" ON "operator_flags" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "rulesets_one_active_key" ON "rulesets" USING btree ("active") WHERE "rulesets"."active";--> statement-breakpoint
CREATE INDEX "user_restrictions_user_id_kind_idx" ON "user_restrictions" USING btree ("user_id","kind");--> statement-breakpoint
CREATE INDEX "users_tenant_id_idx" ON "users" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_participants" ADD CONSTRAINT "contest_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_results" ADD CONSTRAINT "contest_results_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_scores" ADD CONSTRAINT "contest_scores_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contests" ADD CONSTRAINT "contests_eligibility_ruleset_version_rulesets_version_fk" FOREIGN KEY ("eligibility_ruleset_version") REFERENCES "public"."rulesets"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" DROP CONSTRAINT "idempotency_keys_pkey";
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY("tenant_id","scope","key");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_is_wallet_owner" CHECK (("accounts"."kind" = 'user_wallet') = ("accounts"."user_id" is not null) and ("accounts"."user_id" is null or "accounts"."user_id" = "accounts"."owner_ref"));--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_scope_shape" CHECK (("idempotency_keys"."scope" = 'service' and "idempotency_keys"."result" is not null and "idempotency_keys"."response_status" is null and "idempotency_keys"."response_body" is null)
        or ("idempotency_keys"."scope" = 'http' and "idempotency_keys"."result" is null and "idempotency_keys"."response_status" between 100 and 599 and "idempotency_keys"."response_body" is not null));