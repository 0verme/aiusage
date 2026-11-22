import { describe, expect, it } from 'vitest';
import {
  buildRollbackSqlBatch,
  createCostRecalculationBackup,
  sha256Text,
  validateCostRecalculationBackup,
  verifyRestoredBackup,
} from './cost-backup.js';
import { snapshotTokenFacts, type DatabaseBreakdownRow, type DatabaseDailyRow } from './recalculate.js';

const breakdown: DatabaseBreakdownRow = {
  device_id: 'device-a', usage_date: '2026-10-02', provider: 'openai', product: 'codex',
  channel: 'cli', model: 'gpt-6.1-sol', project: '/local/project', project_display: 'project',
  project_alias: null, event_count: 2, session_count: 1, input_tokens: 100, cached_input_tokens: 20,
  cache_write_tokens: 0, output_tokens: 60, reasoning_output_tokens: 15, estimated_cost_usd: 0.0123,
  cost_status: 'estimated', pricing_version: 'old-catalog', extra_metrics_json: null,
  cost_source: 'legacy_unknown', reported_cost_usd: 0.02, reported_cost_source: 'client_estimate',
  output_tokens_includes_reasoning: 1,
  prior_estimated_cost_usd: null, prior_cost_status: null, prior_cost_source: null, prior_pricing_version: null,
};

const daily: DatabaseDailyRow = {
  device_id: 'device-a', usage_date: '2026-10-02', event_count: 2, input_tokens: 100,
  cached_input_tokens: 20, cache_write_tokens: 0, output_tokens: 60, reasoning_output_tokens: 15,
  estimated_cost_usd: 0.0123, cost_status: 'estimated', pricing_version: 'old-catalog',
  cost_source: 'legacy_unknown', top_project_by_cost: 'project', top_project_cost_usd: 0.012300000000000003,
  top_model_by_cost: 'gpt-6.1-sol', top_model_cost_usd: null,
  prior_estimated_cost_usd: null, prior_cost_status: null, prior_cost_source: null, prior_pricing_version: null,
};

describe('cost recalculation backups', () => {
  it('creates a hashed financial snapshot and rejects tampering', () => {
    const tokenFactsSha256 = sha256Text(snapshotTokenFacts([breakdown], [daily]));
    const backup = createCostRecalculationBackup([breakdown], [daily], {
      pricingVersion: 'new-catalog', tokenFactsSha256,
      createdAt: '2026-11-18T12:00:00.000Z', from: '2026-10-02', to: '2026-10-02',
    });
    expect(validateCostRecalculationBackup(JSON.parse(JSON.stringify(backup)))).toEqual(backup);
    expect(() => validateCostRecalculationBackup({ ...backup, breakdowns: [] })).toThrow(/SHA-256/);
    expect(backup.breakdowns[0]).not.toHaveProperty('input_tokens');
    expect(backup.breakdowns[0]).toMatchObject({ estimated_cost_usd: 0.0123, cost_source: 'legacy_unknown' });
    expect(sha256Text(snapshotTokenFacts([{ ...breakdown, input_tokens: 101 }], [daily])))
      .not.toBe(backup.tokenFactsSha256);
  });

  it('builds an idempotent cost-only rollback and verifies restored values', () => {
    const tokenFactsSha256 = sha256Text(snapshotTokenFacts([breakdown], [daily]));
    const backup = createCostRecalculationBackup([breakdown], [daily], {
      pricingVersion: 'new-catalog',
      tokenFactsSha256,
      createdAt: '2026-11-18T12:00:00.000Z',
    });
    const first = buildRollbackSqlBatch(backup, '2026-10-02');
    expect(buildRollbackSqlBatch(backup, '2026-10-02')).toBe(first);
    expect(first).toContain("cost_source = 'legacy_unknown'");
    expect(first).toContain(`top_project_cost_usd = ${daily.top_project_cost_usd},`);
    expect(first).toContain('top_model_cost_usd = NULL');
    expect(first).not.toMatch(/input_tokens|cached_input_tokens|output_tokens|reasoning_output_tokens/);
    expect(verifyRestoredBackup(backup, [breakdown], [daily])).toBe(true);
    expect(verifyRestoredBackup(backup, [{ ...breakdown, estimated_cost_usd: 0.9 }], [daily])).toBe(false);
  });
});
