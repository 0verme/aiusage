ALTER TABLE daily_usage ADD COLUMN prior_estimated_cost_usd REAL;
ALTER TABLE daily_usage ADD COLUMN prior_cost_status TEXT;
ALTER TABLE daily_usage ADD COLUMN prior_cost_source TEXT;
ALTER TABLE daily_usage ADD COLUMN prior_pricing_version TEXT;

ALTER TABLE daily_usage_breakdown ADD COLUMN prior_estimated_cost_usd REAL;
ALTER TABLE daily_usage_breakdown ADD COLUMN prior_cost_status TEXT;
ALTER TABLE daily_usage_breakdown ADD COLUMN prior_cost_source TEXT;
ALTER TABLE daily_usage_breakdown ADD COLUMN prior_pricing_version TEXT;

CREATE INDEX IF NOT EXISTS idx_breakdown_pricing_version
  ON daily_usage_breakdown(pricing_version, cost_source, usage_date);
