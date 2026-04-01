-- Add per-phase migration timestamps to woo_connections.
-- products_migrated_at: stamped when Phase 1 (products) completes.
-- orders_migrated_at:   stamped when Phase 2 (orders) completes.
ALTER TABLE woo_connections
  ADD COLUMN IF NOT EXISTS products_migrated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS orders_migrated_at   TIMESTAMPTZ;
