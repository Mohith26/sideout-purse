-- Sideout's tenant row: reference data the platform cannot run without, with an id every
-- environment agrees on. Mirrors SIDEOUT_TENANT_ID in src/tenants.ts; a test asserts they
-- match. Idempotent so a re-run against a database that already has it changes nothing.
INSERT INTO "tenants" ("id", "name", "status")
VALUES ('tnt_01a0b16a-b475-74d4-b1cb-2dbdc08845a9', 'Sideout', 'active')
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
-- Every state change is audited, including the one that created the first tenant.
INSERT INTO "audit_log" ("id", "tenant_id", "actor_kind", "actor_ref", "action", "subject_kind", "subject_id", "before", "after")
SELECT 'aud_01a0b16b-522c-70a5-8e87-d4a6112fd6c3', t."id", 'system', 'migration:0001_seed_sideout_tenant', 'tenant.created', 'tenant', t."id", NULL,
       jsonb_build_object('id', t."id", 'name', t."name", 'status', t."status")
FROM "tenants" t
WHERE t."id" = 'tnt_01a0b16a-b475-74d4-b1cb-2dbdc08845a9'
ON CONFLICT ("id") DO NOTHING;
