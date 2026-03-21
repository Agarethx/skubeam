-- Add payload column for worker queue jobs and created_at for ordering
ALTER TABLE sync_jobs
  ADD COLUMN IF NOT EXISTS payload jsonb,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

-- Partial index so the worker finds pending jobs fast
CREATE INDEX IF NOT EXISTS idx_sync_jobs_pending
  ON sync_jobs(status, created_at)
  WHERE status = 'pending';
