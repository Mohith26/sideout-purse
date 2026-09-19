-- Self-serve leases are immutable receipts. Retirement uses the existing tenant status
-- and API-key revoked_at grants; no DELETE privilege is added to history or to tenants.
GRANT SELECT, INSERT ON TABLE sandbox_leases TO purse_app;
