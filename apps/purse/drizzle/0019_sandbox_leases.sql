ALTER TYPE "public"."tenant_status" ADD VALUE 'retired';--> statement-breakpoint
CREATE TABLE "sandbox_leases" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"request_key" text NOT NULL,
	"origin" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sandbox_leases" ADD CONSTRAINT "sandbox_leases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_leases_request_idx" ON "sandbox_leases" USING btree ("address","request_key");--> statement-breakpoint
CREATE INDEX "sandbox_leases_expiry_idx" ON "sandbox_leases" USING btree ("expires_at");