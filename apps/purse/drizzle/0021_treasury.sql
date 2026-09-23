CREATE TYPE "public"."payment_direction" AS ENUM('deposit', 'withdrawal');--> statement-breakpoint
CREATE TYPE "public"."payment_method_brand" AS ENUM('visa', 'mastercard', 'amex', 'discover', 'bank_account', 'apple_pay', 'paypal');--> statement-breakpoint
CREATE TYPE "public"."payment_method_status" AS ENUM('active', 'expired', 'removed');--> statement-breakpoint
CREATE TYPE "public"."payment_state" AS ENUM('requires_action', 'authorized', 'captured', 'settled', 'requested', 'in_review', 'approved', 'paid', 'failed', 'cancelled', 'refunded', 'returned');--> statement-breakpoint
ALTER TYPE "public"."journal_entry_kind" ADD VALUE 'deposit';--> statement-breakpoint
ALTER TYPE "public"."journal_entry_kind" ADD VALUE 'withdrawal';--> statement-breakpoint
ALTER TYPE "public"."journal_entry_kind" ADD VALUE 'fee';--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" text PRIMARY KEY NOT NULL,
	"payment_id" text NOT NULL,
	"from_state" "payment_state",
	"to_state" "payment_state" NOT NULL,
	"actor" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_events_id_prefix" CHECK ("payment_events"."id" ~ '^pev_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "payment_events_moves" CHECK ("payment_events"."from_state" is null or "payment_events"."from_state" <> "payment_events"."to_state")
);
--> statement-breakpoint
CREATE TABLE "payment_methods" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"brand" "payment_method_brand" NOT NULL,
	"last4" text NOT NULL,
	"exp_month" integer,
	"exp_year" integer,
	"provider_ref" text NOT NULL,
	"provider" text NOT NULL,
	"status" "payment_method_status" DEFAULT 'active' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_methods_tenant_provider_ref_key" UNIQUE("tenant_id","provider_ref"),
	CONSTRAINT "payment_methods_id_prefix" CHECK ("payment_methods"."id" ~ '^pmt_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "payment_methods_last4_shape" CHECK ("payment_methods"."last4" ~ '^[0-9]{4}$'),
	CONSTRAINT "payment_methods_provider_ref_shape" CHECK ("payment_methods"."provider_ref" ~ '^[A-Za-z0-9_-]{6,64}$'),
	CONSTRAINT "payment_methods_brand_supported" CHECK ("payment_methods"."brand" not in ('mastercard', 'paypal')),
	CONSTRAINT "payment_methods_expiry_together" CHECK (("payment_methods"."exp_month" is null) = ("payment_methods"."exp_year" is null) and ("payment_methods"."exp_month" is null or ("payment_methods"."exp_month" between 1 and 12 and "payment_methods"."exp_year" between 2000 and 2100))),
	CONSTRAINT "payment_methods_expiry_by_brand" CHECK (case when "payment_methods"."brand" in ('visa', 'mastercard', 'amex', 'discover') then "payment_methods"."exp_month" is not null else true end)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"direction" "payment_direction" NOT NULL,
	"state" "payment_state" NOT NULL,
	"amount_usd_cents" bigint NOT NULL,
	"fee_usd_cents" bigint DEFAULT 0 NOT NULL,
	"asset" "asset" NOT NULL,
	"payment_method_id" text,
	"provider" text NOT NULL,
	"provider_ref" text,
	"journal_entry_id" text,
	"risk_decision" text,
	"failure_code" text,
	"statement_descriptor" text NOT NULL,
	"funded_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_journal_entry_id_key" UNIQUE("journal_entry_id"),
	CONSTRAINT "payments_tenant_provider_ref_key" UNIQUE("tenant_id","provider_ref"),
	CONSTRAINT "payments_id_prefix" CHECK ("payments"."id" ~ '^pay_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "payments_journal_entry_id_prefix" CHECK ("payments"."journal_entry_id" is null or "payments"."journal_entry_id" ~ '^je_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount_usd_cents" > 0),
	CONSTRAINT "payments_fee_non_negative" CHECK ("payments"."fee_usd_cents" >= 0),
	CONSTRAINT "payments_asset_is_credit" CHECK ("payments"."asset" = 'CREDIT'),
	CONSTRAINT "payments_direction_states" CHECK (case "payments"."direction"
        when 'deposit' then "payments"."state" in ('requires_action', 'authorized', 'captured', 'settled', 'failed', 'cancelled', 'refunded')
        when 'withdrawal' then "payments"."state" in ('requested', 'in_review', 'approved', 'paid', 'failed', 'cancelled', 'returned')
      end),
	CONSTRAINT "payments_journal_entry_iff_funded" CHECK (("payments"."funded_at" is not null) = ("payments"."journal_entry_id" is not null)
        and ("payments"."funded_at" is not null) = (case "payments"."direction"
          when 'deposit' then "payments"."state" in ('captured', 'settled', 'refunded')
          when 'withdrawal' then "payments"."state" in ('approved', 'paid', 'returned')
        end)),
	CONSTRAINT "payments_completed_iff_terminal" CHECK (("payments"."completed_at" is not null) = ("payments"."state" in ('settled', 'paid', 'failed', 'cancelled', 'refunded', 'returned'))),
	CONSTRAINT "payments_failure_code_shape" CHECK ("payments"."failure_code" is null or "payments"."failure_code" ~ '^[a-z][a-z0-9_]{2,48}$'),
	CONSTRAINT "payments_statement_descriptor_shape" CHECK (length("payments"."statement_descriptor") between 5 and 22)
);
--> statement-breakpoint
ALTER TABLE "contests" ADD COLUMN "rake_bps" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_payment_method_id_payment_methods_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_events_payment_id_idx" ON "payment_events" USING btree ("payment_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_methods_one_default_per_user" ON "payment_methods" USING btree ("user_id") WHERE "payment_methods"."is_default" and "payment_methods"."status" = 'active';--> statement-breakpoint
CREATE INDEX "payment_methods_user_id_idx" ON "payment_methods" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "payments_tenant_created_idx" ON "payments" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "payments_user_id_idx" ON "payments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "payments_state_idx" ON "payments" USING btree ("state");--> statement-breakpoint
ALTER TABLE "contests" ADD CONSTRAINT "contests_rake_bps_range" CHECK ("contests"."rake_bps" between 0 and 5000);