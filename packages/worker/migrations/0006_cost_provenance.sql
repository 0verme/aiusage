ALTER TABLE daily_usage ADD COLUMN cost_source TEXT NOT NULL DEFAULT 'legacy_unknown';
ALTER TABLE daily_usage_breakdown ADD COLUMN cost_source TEXT NOT NULL DEFAULT 'legacy_unknown';
ALTER TABLE daily_usage_breakdown ADD COLUMN reported_cost_usd REAL;
ALTER TABLE daily_usage_breakdown ADD COLUMN reported_cost_source TEXT;
ALTER TABLE daily_usage_breakdown ADD COLUMN output_tokens_includes_reasoning INTEGER;

CREATE INDEX IF NOT EXISTS idx_breakdown_unpriced
  ON daily_usage_breakdown(cost_status, usage_date, provider, product, model);
