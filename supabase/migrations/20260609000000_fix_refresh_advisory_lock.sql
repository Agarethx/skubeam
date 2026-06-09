-- Fix refresh_sku_analytics to skip concurrent calls using advisory lock.
-- Without this, multiple simultaneous webhook deliveries queue ExclusiveLocks
-- on the materialized view and cause Cloudflare 522 timeouts.
CREATE OR REPLACE FUNCTION refresh_sku_analytics()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- pg_try_advisory_xact_lock returns false immediately if another session
  -- holds the lock (instead of waiting). Lock is released at transaction end.
  IF pg_try_advisory_xact_lock(1234567890) THEN
    REFRESH MATERIALIZED VIEW CONCURRENTLY sku_analytics;
  END IF;
END;
$$;
