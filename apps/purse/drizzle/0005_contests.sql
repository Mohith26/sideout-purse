CREATE TYPE "public"."contest_kind" AS ENUM('tournament', 'head_to_head', 'pool');--> statement-breakpoint
CREATE TYPE "public"."contest_state" AS ENUM('draft', 'open', 'locked', 'in_progress', 'awaiting_settlement', 'settling', 'settled', 'cancelled', 'voided');--> statement-breakpoint
CREATE TYPE "public"."participant_state" AS ENUM('entered', 'withdrawn', 'disqualified');--> statement-breakpoint
CREATE TYPE "public"."settlement_policy" AS ENUM('operator_close', 'auto');--> statement-breakpoint
CREATE TYPE "public"."tie_break_rule" AS ENUM('split_evenly', 'higher_seed_wins', 'earliest_submission_wins');--> statement-breakpoint
CREATE TABLE "contest_participants" (
	"id" text PRIMARY KEY NOT NULL,
	"contest_id" text NOT NULL,
	"user_id" text NOT NULL,
	"team_ref" text,
	"seed" integer,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"entry_journal_entry_id" text NOT NULL,
	"state" "participant_state" DEFAULT 'entered' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contest_participants_contest_id_user_id_key" UNIQUE("contest_id","user_id"),
	CONSTRAINT "contest_participants_entry_journal_entry_id_key" UNIQUE("entry_journal_entry_id"),
	CONSTRAINT "contest_participants_id_prefix" CHECK ("contest_participants"."id" ~ '^ent_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "contest_participants_user_id_prefix" CHECK ("contest_participants"."user_id" ~ '^usr_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "contest_participants_seed_positive" CHECK ("contest_participants"."seed" is null or "contest_participants"."seed" >= 1)
);
--> statement-breakpoint
CREATE TABLE "contest_results" (
	"id" text PRIMARY KEY NOT NULL,
	"contest_id" text NOT NULL,
	"user_id" text NOT NULL,
	"placement" integer NOT NULL,
	"score" numeric,
	"payout_amount" bigint NOT NULL,
	"payout_journal_entry_id" text,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contest_results_contest_id_user_id_key" UNIQUE("contest_id","user_id"),
	CONSTRAINT "contest_results_id_prefix" CHECK ("contest_results"."id" ~ '^res_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "contest_results_user_id_prefix" CHECK ("contest_results"."user_id" ~ '^usr_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "contest_results_placement_positive" CHECK ("contest_results"."placement" >= 1),
	CONSTRAINT "contest_results_payout_non_negative" CHECK ("contest_results"."payout_amount" >= 0),
	CONSTRAINT "contest_results_zero_payout_has_no_entry" CHECK (("contest_results"."payout_amount" > 0) = ("contest_results"."payout_journal_entry_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "contest_scores" (
	"id" text PRIMARY KEY NOT NULL,
	"contest_id" text NOT NULL,
	"user_id" text NOT NULL,
	"score" numeric,
	"attempt_finished" boolean DEFAULT false NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_ref" text,
	"superseded_by" text,
	CONSTRAINT "contest_scores_id_prefix" CHECK ("contest_scores"."id" ~ '^sco_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "contest_scores_user_id_prefix" CHECK ("contest_scores"."user_id" ~ '^usr_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "contest_scores_not_self_superseded" CHECK ("contest_scores"."superseded_by" is null or "contest_scores"."superseded_by" <> "contest_scores"."id")
);
--> statement-breakpoint
CREATE TABLE "contests" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"external_id" text NOT NULL,
	"kind" "contest_kind" NOT NULL,
	"title" text NOT NULL,
	"asset" "asset" NOT NULL,
	"entry_amount" bigint NOT NULL,
	"max_participants" integer,
	"prize_structure" jsonb NOT NULL,
	"tie_break" "tie_break_rule" DEFAULT 'split_evenly' NOT NULL,
	"settlement_policy" "settlement_policy" DEFAULT 'operator_close' NOT NULL,
	"eligibility_ruleset_version" text,
	"state" "contest_state" DEFAULT 'draft' NOT NULL,
	"opens_at" timestamp with time zone,
	"locks_at" timestamp with time zone,
	"escrow_account_id" text NOT NULL,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contests_tenant_id_external_id_key" UNIQUE("tenant_id","external_id"),
	CONSTRAINT "contests_escrow_account_id_key" UNIQUE("escrow_account_id"),
	CONSTRAINT "contests_id_prefix" CHECK ("contests"."id" ~ '^cnt_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "contests_entry_amount_positive" CHECK ("contests"."entry_amount" > 0),
	CONSTRAINT "contests_max_participants_positive" CHECK ("contests"."max_participants" is null or "contests"."max_participants" >= 1),
	CONSTRAINT "contests_external_id_not_blank" CHECK (length(trim("contests"."external_id")) > 0),
	CONSTRAINT "contests_settled_at_iff_settled" CHECK (("contests"."state" = 'settled') = ("contests"."settled_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"tenant_id" text NOT NULL,
	"key" text NOT NULL,
	"operation" text NOT NULL,
	"request_hash" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY("tenant_id","key")
);
--> statement-breakpoint
ALTER TABLE "contest_participants" ADD CONSTRAINT "contest_participants_contest_id_contests_id_fk" FOREIGN KEY ("contest_id") REFERENCES "public"."contests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_participants" ADD CONSTRAINT "contest_participants_entry_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_results" ADD CONSTRAINT "contest_results_contest_id_contests_id_fk" FOREIGN KEY ("contest_id") REFERENCES "public"."contests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_results" ADD CONSTRAINT "contest_results_payout_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("payout_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_scores" ADD CONSTRAINT "contest_scores_contest_id_contests_id_fk" FOREIGN KEY ("contest_id") REFERENCES "public"."contests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_scores" ADD CONSTRAINT "contest_scores_superseded_by_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."contest_scores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contests" ADD CONSTRAINT "contests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contests" ADD CONSTRAINT "contests_escrow_account_id_asset_fk" FOREIGN KEY ("escrow_account_id","asset") REFERENCES "public"."accounts"("id","asset") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contest_participants_contest_id_state_idx" ON "contest_participants" USING btree ("contest_id","state");--> statement-breakpoint
CREATE INDEX "contest_results_contest_id_idx" ON "contest_results" USING btree ("contest_id");--> statement-breakpoint
CREATE INDEX "contest_scores_contest_id_user_id_idx" ON "contest_scores" USING btree ("contest_id","user_id");--> statement-breakpoint
CREATE INDEX "contests_tenant_id_state_idx" ON "contests" USING btree ("tenant_id","state");--> statement-breakpoint
CREATE INDEX "idempotency_keys_created_at_idx" ON "idempotency_keys" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_contest_id_contests_id_fk" FOREIGN KEY ("contest_id") REFERENCES "public"."contests"("id") ON DELETE no action ON UPDATE no action;