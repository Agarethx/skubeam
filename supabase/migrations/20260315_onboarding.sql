-- Add onboarding_done flag to shops
ALTER TABLE shops ADD COLUMN IF NOT EXISTS onboarding_done boolean DEFAULT false;
