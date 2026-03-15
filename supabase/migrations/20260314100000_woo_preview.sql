-- Add preview flag to shops to track if a merchant has done a WooCommerce preview migration
ALTER TABLE shops ADD COLUMN IF NOT EXISTS woo_migration_preview boolean DEFAULT false;
