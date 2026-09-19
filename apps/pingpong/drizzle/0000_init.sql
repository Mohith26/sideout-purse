CREATE TYPE "public"."ladder_match_status" AS ENUM('challenged', 'reported', 'confirmed', 'declined');--> statement-breakpoint
CREATE TYPE "public"."purse_call_status" AS ENUM('in_flight', 'succeeded', 'refused', 'failed');--> statement-breakpoint
CREATE TYPE "public"."season_status" AS ENUM('enrolling', 'playing', 'closing', 'closed');--> statement-breakpoint
CREATE TABLE "ladder_matches" (
	"id" text PRIMARY KEY NOT NULL,
	"season_id" text NOT NULL,
	"challenger_id" text NOT NULL,
	"defender_id" text NOT NULL,
	"status" "ladder_match_status" DEFAULT 'challenged' NOT NULL,
	"challenger_score" integer,
	"defender_score" integer,
	"reported_by_id" text,
	"reported_at" timestamp with time zone,
	"confirmed_by_id" text,
	"confirmed_at" timestamp with time zone,
	"winner_id" text,
	"ladder_moved" boolean,
	"purse_idempotency_key" text,
	"purse_pushed_at" timestamp with time zone,
	"purse_push_error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ladder_matches_id_prefix" CHECK ("ladder_matches"."id" ~ '^lmt_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "ladder_matches_distinct_players" CHECK ("ladder_matches"."challenger_id" <> "ladder_matches"."defender_id"),
	CONSTRAINT "ladder_matches_scores_non_negative" CHECK (("ladder_matches"."challenger_score" is null or "ladder_matches"."challenger_score" >= 0) and ("ladder_matches"."defender_score" is null or "ladder_matches"."defender_score" >= 0))
);
--> statement-breakpoint
CREATE TABLE "players" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"purse_external_id" text NOT NULL,
	"purse_user_id" text,
	"purse_linked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "players_id_prefix" CHECK ("players"."id" ~ '^ppl_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "players_name_key_shape" CHECK ("players"."name_key" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "players_name_length" CHECK (char_length("players"."name") between 1 and 40)
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
	CONSTRAINT "purse_calls_id_prefix" CHECK ("purse_calls"."id" ~ '^ppc_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);
--> statement-breakpoint
CREATE TABLE "season_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"season_id" text NOT NULL,
	"player_id" text NOT NULL,
	"rank" integer NOT NULL,
	"wins" integer DEFAULT 0 NOT NULL,
	"losses" integer DEFAULT 0 NOT NULL,
	"purse_participant_id" text NOT NULL,
	"entered_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "season_entries_id_prefix" CHECK ("season_entries"."id" ~ '^sne_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "season_entries_rank_positive" CHECK ("season_entries"."rank" >= 1),
	CONSTRAINT "season_entries_record_non_negative" CHECK ("season_entries"."wins" >= 0 and "season_entries"."losses" >= 0)
);
--> statement-breakpoint
CREATE TABLE "seasons" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"status" "season_status" DEFAULT 'enrolling' NOT NULL,
	"commissioner_id" text NOT NULL,
	"purse_external_id" text NOT NULL,
	"purse_contest_id" text,
	"purse_contest_state" text,
	"purse_close_preview" jsonb,
	"purse_settlement" jsonb,
	"started_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seasons_id_prefix" CHECK ("seasons"."id" ~ '^ssn_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);
--> statement-breakpoint
ALTER TABLE "ladder_matches" ADD CONSTRAINT "ladder_matches_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ladder_matches" ADD CONSTRAINT "ladder_matches_challenger_id_players_id_fk" FOREIGN KEY ("challenger_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ladder_matches" ADD CONSTRAINT "ladder_matches_defender_id_players_id_fk" FOREIGN KEY ("defender_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ladder_matches" ADD CONSTRAINT "ladder_matches_reported_by_id_players_id_fk" FOREIGN KEY ("reported_by_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ladder_matches" ADD CONSTRAINT "ladder_matches_confirmed_by_id_players_id_fk" FOREIGN KEY ("confirmed_by_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ladder_matches" ADD CONSTRAINT "ladder_matches_winner_id_players_id_fk" FOREIGN KEY ("winner_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season_entries" ADD CONSTRAINT "season_entries_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season_entries" ADD CONSTRAINT "season_entries_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seasons" ADD CONSTRAINT "seasons_commissioner_id_players_id_fk" FOREIGN KEY ("commissioner_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ladder_matches_season_idx" ON "ladder_matches" USING btree ("season_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "players_name_key_idx" ON "players" USING btree ("name_key");--> statement-breakpoint
CREATE UNIQUE INDEX "players_purse_external_id_idx" ON "players" USING btree ("purse_external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "players_purse_user_id_idx" ON "players" USING btree ("purse_user_id");--> statement-breakpoint
CREATE INDEX "purse_calls_started_idx" ON "purse_calls" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "purse_calls_subject_idx" ON "purse_calls" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "season_entries_season_player_idx" ON "season_entries" USING btree ("season_id","player_id");--> statement-breakpoint
CREATE INDEX "season_entries_season_rank_idx" ON "season_entries" USING btree ("season_id","rank");--> statement-breakpoint
CREATE UNIQUE INDEX "seasons_purse_external_id_idx" ON "seasons" USING btree ("purse_external_id");--> statement-breakpoint
CREATE INDEX "seasons_status_idx" ON "seasons" USING btree ("status");