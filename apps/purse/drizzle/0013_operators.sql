CREATE TYPE "public"."operator_role" AS ENUM('admin', 'operator');--> statement-breakpoint
CREATE TABLE "operator_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"operator_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_sessions_id_prefix" CHECK ("operator_sessions"."id" ~ '^ops_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "operator_sessions_token_hash_shape" CHECK ("operator_sessions"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "operator_sessions_expires_after_created" CHECK ("operator_sessions"."expires_at" > "operator_sessions"."created_at")
);
--> statement-breakpoint
CREATE TABLE "operators" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "operator_role" DEFAULT 'operator' NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operators_id_prefix" CHECK ("operators"."id" ~ '^opr_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "operators_email_shape" CHECK ("operators"."email" = lower("operators"."email") and "operators"."email" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' and length("operators"."email") <= 254),
	CONSTRAINT "operators_password_hash_argon2id" CHECK ("operators"."password_hash" like '$argon2id$%')
);
--> statement-breakpoint
ALTER TABLE "operator_sessions" ADD CONSTRAINT "operator_sessions_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_sessions_token_hash_key" ON "operator_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "operator_sessions_operator_id_idx" ON "operator_sessions" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "operator_sessions_expires_at_idx" ON "operator_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operators_email_key" ON "operators" USING btree ("email");