-- Existing rows may have been produced by older partial imports. Require a
-- complete scan before using them as the baseline for product-scoped imports.
ALTER TABLE daily_usage
  ADD COLUMN snapshot_complete INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_daily_snapshot_completeness
  ON daily_usage(snapshot_complete, usage_date, device_id);
