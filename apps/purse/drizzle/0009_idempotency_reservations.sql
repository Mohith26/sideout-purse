CREATE TABLE "idempotency_reservations" (
	"tenant_id" text NOT NULL,
	"key" text NOT NULL,
	"operation" text NOT NULL,
	"request_hash" text NOT NULL,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_reservations_pkey" PRIMARY KEY("tenant_id","key"),
	CONSTRAINT "idempotency_reservations_window" CHECK ("idempotency_reservations"."expires_at" >= "idempotency_reservations"."reserved_at")
);
--> statement-breakpoint
ALTER TABLE "idempotency_reservations" ADD CONSTRAINT "idempotency_reservations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idempotency_reservations_reserved_at_idx" ON "idempotency_reservations" USING btree ("reserved_at");