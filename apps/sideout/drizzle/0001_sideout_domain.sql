CREATE TYPE "public"."actor_kind" AS ENUM('player', 'organizer', 'system');--> statement-breakpoint
CREATE TYPE "public"."division" AS ENUM('open', 'womens', 'mens', 'coed', 'rec');--> statement-breakpoint
CREATE TYPE "public"."donation_provider" AS ENUM('dev', 'stripe');--> statement-breakpoint
CREATE TYPE "public"."donation_status" AS ENUM('pending', 'succeeded', 'refunded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."match_slot" AS ENUM('a', 'b');--> statement-breakpoint
CREATE TYPE "public"."match_status" AS ENUM('scheduled', 'in_progress', 'awaiting_scores', 'disputed', 'final', 'forfeited', 'bye');--> statement-breakpoint
CREATE TYPE "public"."sponsor_tier" AS ENUM('presenting', 'court', 'prize');--> statement-breakpoint
CREATE TYPE "public"."team_role" AS ENUM('captain', 'player');--> statement-breakpoint
CREATE TYPE "public"."team_status" AS ENUM('forming', 'registered', 'checked_in', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."tournament_format" AS ENUM('pool_to_bracket', 'single_elim', 'double_elim', 'round_robin');--> statement-breakpoint
CREATE TYPE "public"."tournament_status" AS ENUM('draft', 'registration_open', 'registration_closed', 'live', 'awaiting_settlement', 'settled', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('player', 'organizer');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_kind" "actor_kind" NOT NULL,
	"actor_user_id" text,
	"action" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"detail" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_id_prefix" CHECK ("audit_log"."id" ~ '^aud_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);
--> statement-breakpoint
CREATE TABLE "auth_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"phone_e164" text NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_codes_id_prefix" CHECK ("auth_codes"."id" ~ '^otp_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);
--> statement-breakpoint
CREATE TABLE "donation_provider_events" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" "donation_provider" NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"donation_id" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "donation_provider_events_id_prefix" CHECK ("donation_provider_events"."id" ~ '^dpe_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);
--> statement-breakpoint
CREATE TABLE "donations" (
	"id" text PRIMARY KEY NOT NULL,
	"tournament_id" text NOT NULL,
	"team_id" text,
	"user_id" text,
	"amount_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"provider" "donation_provider" NOT NULL,
	"provider_ref" text NOT NULL,
	"status" "donation_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "donations_id_prefix" CHECK ("donations"."id" ~ '^don_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "donations_amount_positive" CHECK ("donations"."amount_cents" > 0),
	CONSTRAINT "donations_currency_shape" CHECK ("donations"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" text PRIMARY KEY NOT NULL,
	"tournament_id" text NOT NULL,
	"pool_id" text,
	"round" integer NOT NULL,
	"bracket_position" integer,
	"court_label" text,
	"team_a_id" text,
	"team_b_id" text,
	"team_a_seed" integer,
	"team_b_seed" integer,
	"best_of" integer NOT NULL,
	"status" "match_status" DEFAULT 'scheduled' NOT NULL,
	"winner_team_id" text,
	"next_match_id" text,
	"next_match_slot" "match_slot",
	"scheduled_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "matches_id_prefix" CHECK ("matches"."id" ~ '^mch_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "matches_round_positive" CHECK ("matches"."round" >= 1),
	CONSTRAINT "matches_best_of_values" CHECK ("matches"."best_of" IN (1, 3)),
	CONSTRAINT "matches_pool_xor_bracket" CHECK (("matches"."pool_id" IS NOT NULL AND "matches"."bracket_position" IS NULL) OR ("matches"."pool_id" IS NULL AND "matches"."bracket_position" IS NOT NULL)),
	CONSTRAINT "matches_distinct_teams" CHECK ("matches"."team_a_id" IS NULL OR "matches"."team_b_id" IS NULL OR "matches"."team_a_id" <> "matches"."team_b_id"),
	CONSTRAINT "matches_winner_is_participant" CHECK ("matches"."winner_team_id" IS NULL OR "matches"."winner_team_id" = "matches"."team_a_id" OR "matches"."winner_team_id" = "matches"."team_b_id"),
	CONSTRAINT "matches_bye_shape" CHECK ("matches"."status" <> 'bye' OR ("matches"."team_a_id" IS NOT NULL AND "matches"."team_b_id" IS NULL AND "matches"."winner_team_id" = "matches"."team_a_id")),
	CONSTRAINT "matches_next_slot_with_next" CHECK (("matches"."next_match_id" IS NULL) = ("matches"."next_match_slot" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "pool_teams" (
	"id" text PRIMARY KEY NOT NULL,
	"pool_id" text NOT NULL,
	"team_id" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pool_teams_id_prefix" CHECK ("pool_teams"."id" ~ '^plt_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "pool_teams_position_positive" CHECK ("pool_teams"."position" >= 1)
);
--> statement-breakpoint
CREATE TABLE "pools" (
	"id" text PRIMARY KEY NOT NULL,
	"tournament_id" text NOT NULL,
	"label" text NOT NULL,
	"sequence" integer NOT NULL,
	"court_label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pools_id_prefix" CHECK ("pools"."id" ~ '^pol_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);
--> statement-breakpoint
CREATE TABLE "sets" (
	"id" text PRIMARY KEY NOT NULL,
	"match_id" text NOT NULL,
	"set_number" integer NOT NULL,
	"team_a_points" integer NOT NULL,
	"team_b_points" integer NOT NULL,
	"agreed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sets_id_prefix" CHECK ("sets"."id" ~ '^set_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "sets_set_number_range" CHECK ("sets"."set_number" BETWEEN 1 AND 3),
	CONSTRAINT "sets_points_nonneg" CHECK ("sets"."team_a_points" >= 0 AND "sets"."team_b_points" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sponsors" (
	"id" text PRIMARY KEY NOT NULL,
	"tournament_id" text NOT NULL,
	"name" text NOT NULL,
	"logo_url" text,
	"tier" "sponsor_tier" NOT NULL,
	"prize_contribution_cents" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sponsors_id_prefix" CHECK ("sponsors"."id" ~ '^spn_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "sponsors_contribution_nonneg" CHECK ("sponsors"."prize_contribution_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" "team_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_members_id_prefix" CHECK ("team_members"."id" ~ '^tmm_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" text PRIMARY KEY NOT NULL,
	"tournament_id" text NOT NULL,
	"name" text NOT NULL,
	"seed" integer,
	"status" "team_status" DEFAULT 'forming' NOT NULL,
	"invited_phone_e164" text,
	"registered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teams_id_prefix" CHECK ("teams"."id" ~ '^tm_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "teams_seed_positive" CHECK ("teams"."seed" IS NULL OR "teams"."seed" >= 1),
	CONSTRAINT "teams_invited_phone_shape" CHECK ("teams"."invited_phone_e164" IS NULL OR "teams"."invited_phone_e164" ~ '^\+[1-9][0-9]{6,14}$')
);
--> statement-breakpoint
CREATE TABLE "tournaments" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"subtitle" text,
	"beneficiary_id" text NOT NULL,
	"venue_name" text NOT NULL,
	"venue_city" text NOT NULL,
	"venue_region" text NOT NULL,
	"venue_timezone" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"format" "tournament_format" NOT NULL,
	"division" "division" NOT NULL,
	"max_teams" integer NOT NULL,
	"entry_donation_cents" bigint NOT NULL,
	"fundraising_goal_cents" bigint NOT NULL,
	"status" "tournament_status" DEFAULT 'draft' NOT NULL,
	"purse_contest_id" text,
	"purse_external_id" text NOT NULL,
	"draw_config" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tournaments_id_prefix" CHECK ("tournaments"."id" ~ '^trn_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "tournaments_slug_shape" CHECK ("tournaments"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "tournaments_max_teams_min" CHECK ("tournaments"."max_teams" >= 2),
	CONSTRAINT "tournaments_entry_donation_nonneg" CHECK ("tournaments"."entry_donation_cents" >= 0),
	CONSTRAINT "tournaments_goal_nonneg" CHECK ("tournaments"."fundraising_goal_cents" >= 0),
	CONSTRAINT "tournaments_ends_after_start" CHECK ("tournaments"."ends_at" >= "tournaments"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"purse_external_id" text NOT NULL,
	"display_name" text NOT NULL,
	"phone_e164" text,
	"avatar_url" text,
	"role" "user_role" DEFAULT 'player' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_id_prefix" CHECK ("users"."id" ~ '^sou_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "users_phone_e164_shape" CHECK ("users"."phone_e164" IS NULL OR "users"."phone_e164" ~ '^\+[1-9][0-9]{6,14}$')
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "donation_provider_events" ADD CONSTRAINT "donation_provider_events_donation_id_donations_id_fk" FOREIGN KEY ("donation_id") REFERENCES "public"."donations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "donations" ADD CONSTRAINT "donations_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "donations" ADD CONSTRAINT "donations_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "donations" ADD CONSTRAINT "donations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_pool_id_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."pools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_team_a_id_teams_id_fk" FOREIGN KEY ("team_a_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_team_b_id_teams_id_fk" FOREIGN KEY ("team_b_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_winner_team_id_teams_id_fk" FOREIGN KEY ("winner_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_next_match_id_matches_id_fk" FOREIGN KEY ("next_match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pool_teams" ADD CONSTRAINT "pool_teams_pool_id_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."pools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pool_teams" ADD CONSTRAINT "pool_teams_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pools" ADD CONSTRAINT "pools_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sets" ADD CONSTRAINT "sets_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sponsors" ADD CONSTRAINT "sponsors_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_beneficiary_id_charities_id_fk" FOREIGN KEY ("beneficiary_id") REFERENCES "public"."charities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_subject_idx" ON "audit_log" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "audit_log_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "auth_codes_phone_created_idx" ON "auth_codes" USING btree ("phone_e164","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "donation_provider_events_provider_event_key" ON "donation_provider_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE INDEX "donations_tournament_idx" ON "donations" USING btree ("tournament_id");--> statement-breakpoint
CREATE INDEX "donations_team_idx" ON "donations" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "donations_status_idx" ON "donations" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "donations_provider_ref_key" ON "donations" USING btree ("provider","provider_ref");--> statement-breakpoint
CREATE INDEX "matches_tournament_idx" ON "matches" USING btree ("tournament_id");--> statement-breakpoint
CREATE INDEX "matches_pool_idx" ON "matches" USING btree ("pool_id");--> statement-breakpoint
CREATE INDEX "matches_status_idx" ON "matches" USING btree ("status");--> statement-breakpoint
CREATE INDEX "matches_next_match_idx" ON "matches" USING btree ("next_match_id");--> statement-breakpoint
CREATE UNIQUE INDEX "matches_tournament_bracket_position_key" ON "matches" USING btree ("tournament_id","bracket_position");--> statement-breakpoint
CREATE UNIQUE INDEX "pool_teams_pool_team_key" ON "pool_teams" USING btree ("pool_id","team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pool_teams_pool_position_key" ON "pool_teams" USING btree ("pool_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "pool_teams_team_key" ON "pool_teams" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "pools_tournament_idx" ON "pools" USING btree ("tournament_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pools_tournament_label_key" ON "pools" USING btree ("tournament_id","label");--> statement-breakpoint
CREATE UNIQUE INDEX "pools_tournament_sequence_key" ON "pools" USING btree ("tournament_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "sets_match_set_number_key" ON "sets" USING btree ("match_id","set_number");--> statement-breakpoint
CREATE INDEX "sponsors_tournament_idx" ON "sponsors" USING btree ("tournament_id");--> statement-breakpoint
CREATE UNIQUE INDEX "team_members_team_user_key" ON "team_members" USING btree ("team_id","user_id");--> statement-breakpoint
CREATE INDEX "team_members_user_idx" ON "team_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "teams_tournament_idx" ON "teams" USING btree ("tournament_id");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_tournament_seed_key" ON "teams" USING btree ("tournament_id","seed");--> statement-breakpoint
CREATE UNIQUE INDEX "tournaments_slug_key" ON "tournaments" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "tournaments_purse_external_id_key" ON "tournaments" USING btree ("purse_external_id");--> statement-breakpoint
CREATE INDEX "tournaments_status_idx" ON "tournaments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tournaments_beneficiary_idx" ON "tournaments" USING btree ("beneficiary_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_purse_external_id_key" ON "users" USING btree ("purse_external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_phone_e164_key" ON "users" USING btree ("phone_e164");