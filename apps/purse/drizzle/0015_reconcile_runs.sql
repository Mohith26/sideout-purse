CREATE TYPE "public"."reconcile_run_source" AS ENUM('schedule', 'internal', 'console', 'cli', 'test');--> statement-breakpoint
CREATE TABLE "reconcile_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"ok" boolean NOT NULL,
	"source" "reconcile_run_source" NOT NULL,
	"ran_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"failed" jsonb NOT NULL,
	"report" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconcile_runs_id_prefix" CHECK ("reconcile_runs"."id" ~ '^rcr_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "reconcile_runs_duration_non_negative" CHECK ("reconcile_runs"."duration_ms" >= 0),
	CONSTRAINT "reconcile_runs_failed_matches_ok" CHECK (("reconcile_runs"."ok" and jsonb_array_length("reconcile_runs"."failed") = 0) or (not "reconcile_runs"."ok" and jsonb_array_length("reconcile_runs"."failed") > 0))
);
--> statement-breakpoint
CREATE INDEX "reconcile_runs_ran_at_idx" ON "reconcile_runs" USING btree ("ran_at");