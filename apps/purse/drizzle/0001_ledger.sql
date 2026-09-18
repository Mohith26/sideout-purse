CREATE TYPE "public"."account_kind" AS ENUM('user_wallet', 'contest_escrow', 'sponsor_funding', 'promo_liability', 'platform_fee', 'external_settlement');--> statement-breakpoint
CREATE TYPE "public"."account_status" AS ENUM('open', 'frozen', 'closed');--> statement-breakpoint
CREATE TYPE "public"."asset" AS ENUM('POINTS', 'CREDIT');--> statement-breakpoint
CREATE TYPE "public"."audit_actor_kind" AS ENUM('system', 'operator', 'tenant', 'user');--> statement-breakpoint
CREATE TYPE "public"."journal_entry_kind" AS ENUM('issue', 'escrow', 'refund', 'settle', 'void', 'reversal', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."ledger_side" AS ENUM('debit', 'credit');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" "account_kind" NOT NULL,
	"owner_ref" text,
	"asset" "asset" NOT NULL,
	"normal_side" "ledger_side" NOT NULL,
	"status" "account_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_tenant_kind_owner_asset_key" UNIQUE NULLS NOT DISTINCT("tenant_id","kind","owner_ref","asset"),
	CONSTRAINT "accounts_id_asset_key" UNIQUE("id","asset"),
	CONSTRAINT "accounts_id_prefix" CHECK ("accounts"."id" ~ '^acct_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "accounts_normal_side_by_kind" CHECK ("accounts"."normal_side" = (case "accounts"."kind"
        when 'user_wallet' then 'credit'
        when 'contest_escrow' then 'credit'
        when 'sponsor_funding' then 'debit'
        when 'promo_liability' then 'credit'
        when 'platform_fee' then 'credit'
        when 'external_settlement' then 'debit'
      end)::ledger_side),
	CONSTRAINT "accounts_owner_ref_by_kind" CHECK (case "accounts"."kind"
        when 'user_wallet' then "accounts"."owner_ref" is not null and "accounts"."owner_ref" ~ '^usr_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        when 'contest_escrow' then "accounts"."owner_ref" is not null and "accounts"."owner_ref" ~ '^cnt_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        else true
      end)
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"actor_kind" "audit_actor_kind" NOT NULL,
	"actor_ref" text,
	"action" text NOT NULL,
	"subject" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_id_prefix" CHECK ("audit_log"."id" ~ '^aud_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" "journal_entry_kind" NOT NULL,
	"description" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"contest_id" text,
	"reverses_entry_id" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"posted_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_entries_id_prefix" CHECK ("journal_entries"."id" ~ '^je_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "journal_entries_contest_id_prefix" CHECK ("journal_entries"."contest_id" is null or "journal_entries"."contest_id" ~ '^cnt_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "journal_entries_reversal_not_self" CHECK ("journal_entries"."reverses_entry_id" is null or "journal_entries"."reverses_entry_id" <> "journal_entries"."id")
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"entry_id" text NOT NULL,
	"account_id" text NOT NULL,
	"direction" "ledger_side" NOT NULL,
	"amount" bigint NOT NULL,
	"asset" "asset" NOT NULL,
	"sequence" integer NOT NULL,
	CONSTRAINT "journal_lines_entry_id_sequence_key" UNIQUE("entry_id","sequence"),
	CONSTRAINT "journal_lines_id_prefix" CHECK ("journal_lines"."id" ~ '^jl_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "journal_lines_amount_positive" CHECK ("journal_lines"."amount" > 0),
	CONSTRAINT "journal_lines_sequence_positive" CHECK ("journal_lines"."sequence" >= 1)
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reverses_entry_id_fk" FOREIGN KEY ("reverses_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_id_asset_fk" FOREIGN KEY ("account_id","asset") REFERENCES "public"."accounts"("id","asset") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_tenant_id_idx" ON "accounts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "audit_log_subject_idx" ON "audit_log" USING btree ("subject");--> statement-breakpoint
CREATE INDEX "audit_log_tenant_id_created_at_idx" ON "audit_log" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_idempotency_key_key" ON "journal_entries" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_reverses_entry_id_key" ON "journal_entries" USING btree ("reverses_entry_id") WHERE "journal_entries"."reverses_entry_id" is not null;--> statement-breakpoint
CREATE INDEX "journal_entries_tenant_id_posted_at_idx" ON "journal_entries" USING btree ("tenant_id","posted_at");--> statement-breakpoint
CREATE INDEX "journal_entries_contest_id_idx" ON "journal_entries" USING btree ("contest_id") WHERE "journal_entries"."contest_id" is not null;--> statement-breakpoint
CREATE INDEX "journal_lines_account_id_idx" ON "journal_lines" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "journal_lines_entry_id_idx" ON "journal_lines" USING btree ("entry_id");