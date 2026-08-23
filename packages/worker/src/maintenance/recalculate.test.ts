import { describe, expect, it } from 'vitest';
import {
  buildRecalculationPlan,
  buildSqlBatch,
  snapshotTokenFacts,
  type DatabaseBreakdownRow,
  type DatabaseDailyRow,
} from './recalculate.js';

function breakdown(overrides: Partial<DatabaseBreakdownRow> = {}): DatabaseBreakdownRow {
  return {
    device_id: 'device-a',
    usage_date: '2026-08-01',
    provider: 'openai-codex',
    product: 'pi',
    channel: 'cli',
    model: 'gpt-5.6-luna',
    project: '/secret/project',
    project_display: 'project',
    project_alias: null,
    event_count: 1,
    session_count: 1,
    input_tokens: 1_000_000,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 1_000_000,
    reasoning_output_tokens: 0,
    estimated_cost_usd: 0,
    cost_status: 'unavailable',
    pricing_version: '2026-07-26-legacy-v1',
    extra_metrics_json: null,
    ...overrides,
  };
}

function daily(overrides: Partial<DatabaseDailyRow> = {}): DatabaseDailyRow {
  return {
    device_id: 'device-a',
    usage_date: '2026-08-01',
    event_count: 1,
    input_tokens: 1_000_000,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 1_000_000,
    reasoning_output_tokens: 0,
    estimated_cost_usd: 0,
    cost_status: 'unavailable',
    pricing_version: '2026-07-26-legacy-v1',
    top_project_by_cost: 'unknown',
    top_project_cost_usd: 0,
    top_model_by_cost: 'unknown',
    top_model_cost_usd: 0,
    ...overrides,
  };
}

describe('historical cost recalculation plan', () => {
  it('reprices normalized identities without changing token facts', () => {
    const beforeBreakdowns = [
      breakdown(),
      breakdown({
        provider: 'opencode',
        product: 'opencode',
        model: 'hy3-free',
        project: '/secret/other',
        project_display: 'other',
        input_tokens: 100,
        output_tokens: 50,
        estimated_cost_usd: 0,
      }),
    ];
    const beforeDaily = [daily({ event_count: 2, input_tokens: 1_000_100, output_tokens: 1_000_050 })];
    const beforeFacts = snapshotTokenFacts(beforeBreakdowns, beforeDaily);
    const plan = buildRecalculationPlan(beforeBreakdowns, beforeDaily, {
      from: '2026-08-01',
      to: '2026-08-01',
    });

    expect(plan.breakdowns[0]).toMatchObject({ estimatedCostUsd: 11, costStatus: 'exact', changed: true });
    expect(plan.breakdowns[1]).toMatchObject({ estimatedCostUsd: 0, costStatus: 'unavailable', changed: true });
    expect(plan.daily[0]).toMatchObject({
      estimatedCostUsd: 11,
      costStatus: 'unavailable',
      topModel: 'gpt-5.6-luna',
      topProjectCostUsd: 11,
      changed: true,
    });
    expect(plan.summary.before).toEqual({
      totalEvents: 2,
      totalTokens: 2_000_150,
      totalCostUsd: 0,
      costBearingEvents: 0,
    });
    expect(plan.summary.after).toEqual({
      totalEvents: 2,
      totalTokens: 2_000_150,
      totalCostUsd: 11,
      costBearingEvents: 1,
    });
    expect(plan.summary.modelsStillUnavailable).toEqual([
      expect.objectContaining({ provider: 'opencode', product: 'opencode', model: 'hy3-free', totalTokens: 150 }),
    ]);
    expect(JSON.stringify(plan.summary)).not.toContain('/secret/');
    expect(snapshotTokenFacts(beforeBreakdowns, beforeDaily)).toBe(beforeFacts);
  });

  it('keeps positive vendor-reported OpenCode cost while refreshing version', () => {
    const row = breakdown({
      provider: 'openai',
      product: 'opencode',
      model: 'gpt-5.6-luna',
      estimated_cost_usd: 0.42,
      cost_status: 'exact',
    });
    const plan = buildRecalculationPlan([row], [daily()], {});

    expect(plan.breakdowns[0]).toMatchObject({ estimatedCostUsd: 0.42, costStatus: 'exact', changed: true });
  });

  it('generates cost-only SQL and never writes token columns', () => {
    const plan = buildRecalculationPlan([breakdown()], [daily()], {});
    const sql = buildSqlBatch(plan, '2026-08-01', '2026-08-23T12:00:00.000Z');

    expect(sql).toContain('estimated_cost_usd');
    expect(sql).toContain('pricing_version');
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
    expect(sql).not.toMatch(/input_tokens|cached_input_tokens|cache_write_tokens|output_tokens|reasoning_output_tokens/);
  });
});
