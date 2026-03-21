-- Add sale_price to skus: stores the Bsale public sale price (with IVA)
-- This is distinct from cost_price (averageCost / purchase cost)
ALTER TABLE public.skus ADD COLUMN IF NOT EXISTS sale_price numeric;
