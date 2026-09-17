CREATE TYPE "public"."charity_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TABLE "charities" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"website_url" text,
	"logo_url" text,
	"status" charity_status DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "charities_id_prefix" CHECK ("charities"."id" ~ '^chr_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"purse_external_id" text NOT NULL,
	"display_name" text NOT NULL,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_id_prefix" CHECK ("users"."id" ~ '^sou_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "users_purse_external_id_prefix" CHECK ("users"."purse_external_id" ~ '^ext_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "charities_slug_key" ON "charities" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "users_purse_external_id_key" ON "users" USING btree ("purse_external_id");