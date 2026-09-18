CREATE TYPE "public"."consensus_state" AS ENUM('awaiting_first', 'awaiting_second', 'agreed', 'disputed', 'pushed_to_purse', 'confirmed');--> statement-breakpoint
CREATE TYPE "public"."purse_call_status" AS ENUM('in_flight', 'succeeded', 'refused', 'failed');--> statement-breakpoint
CREATE TYPE "public"."purse_entry_state" AS ENUM('entered', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."submission_perspective" AS ENUM('a', 'b');--> statement-breakpoint
CREATE TABLE "match_consensus" (
	"id" text PRIMARY KEY NOT NULL,
	"match_id" text NOT NULL,
	"state" "consensus_state" DEFAULT 'awaiting_first' NOT NULL,
	"agreed_hash" text,
	"disputed_reason" text,
	"disputed_sets" jsonb,
	"resolved_by_user_id" text,
	"idempotency_key" text,
	"pushed_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"last_push_error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "match_consensus_id_prefix" CHECK ("match_consensus"."id" ~ '^mcs_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "match_consensus_agreed_hash_shape" CHECK ("match_consensus"."agreed_hash" IS NULL OR "match_consensus"."agreed_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "match_consensus_key_once_agreed" CHECK ("match_consensus"."state" IN ('awaiting_first', 'awaiting_second', 'disputed') OR "match_consensus"."idempotency_key" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "purse_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"idempotency_key" text,
	"subject_type" text,
	"subject_id" text,
	"request_body" jsonb,
	"status" "purse_call_status" DEFAULT 'in_flight' NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"error" text,
	"replayed" boolean,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	CONSTRAINT "purse_calls_id_prefix" CHECK ("purse_calls"."id" ~ '^pcl_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);
--> statement-breakpoint
CREATE TABLE "purse_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"tournament_id" text NOT NULL,
	"purse_user_id" text NOT NULL,
	"user_id" text,
	"purse_participant_id" text NOT NULL,
	"state" "purse_entry_state" DEFAULT 'entered' NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purse_entries_id_prefix" CHECK ("purse_entries"."id" ~ '^pen_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);
--> statement-breakpoint
CREATE TABLE "purse_webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"outcome" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purse_webhook_events_id_prefix" CHECK ("purse_webhook_events"."id" ~ '^pwe_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);
--> statement-breakpoint
CREATE TABLE "score_submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"match_id" text NOT NULL,
	"submitted_by_user_id" text NOT NULL,
	"submitted_for_team_id" text,
	"perspective" "submission_perspective" NOT NULL,
	"sets" jsonb NOT NULL,
	"hash" text NOT NULL,
	"superseded_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "score_submissions_id_prefix" CHECK ("score_submissions"."id" ~ '^ssb_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "score_submissions_hash_shape" CHECK ("score_submissions"."hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "tournaments" ADD COLUMN "purse_contest_state" text;--> statement-breakpoint
ALTER TABLE "tournaments" ADD COLUMN "purse_close_preview" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "purse_user_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "purse_linked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "purse_verification_state" text;--> statement-breakpoint
ALTER TABLE "match_consensus" ADD CONSTRAINT "match_consensus_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_consensus" ADD CONSTRAINT "match_consensus_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purse_entries" ADD CONSTRAINT "purse_entries_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purse_entries" ADD CONSTRAINT "purse_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_submissions" ADD CONSTRAINT "score_submissions_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_submissions" ADD CONSTRAINT "score_submissions_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_submissions" ADD CONSTRAINT "score_submissions_submitted_for_team_id_teams_id_fk" FOREIGN KEY ("submitted_for_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_submissions" ADD CONSTRAINT "score_submissions_superseded_by_id_score_submissions_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."score_submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "match_consensus_match_key" ON "match_consensus" USING btree ("match_id");--> statement-breakpoint
CREATE UNIQUE INDEX "match_consensus_idempotency_key" ON "match_consensus" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "match_consensus_state_idx" ON "match_consensus" USING btree ("state");--> statement-breakpoint
CREATE INDEX "purse_calls_started_idx" ON "purse_calls" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "purse_calls_subject_idx" ON "purse_calls" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "purse_calls_idempotency_key_idx" ON "purse_calls" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "purse_entries_tournament_user_key" ON "purse_entries" USING btree ("tournament_id","purse_user_id");--> statement-breakpoint
CREATE INDEX "purse_entries_user_idx" ON "purse_entries" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purse_webhook_events_event_id_key" ON "purse_webhook_events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "score_submissions_match_idx" ON "score_submissions" USING btree ("match_id");--> statement-breakpoint
CREATE INDEX "score_submissions_team_idx" ON "score_submissions" USING btree ("submitted_for_team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_purse_user_id_key" ON "users" USING btree ("purse_user_id");