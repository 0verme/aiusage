import { describe, expect, it } from 'vitest';
import { getPricingCatalog } from '@aiusage/shared';
import {
  buildCompatibleSelect,
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
    cost_source: 'legacy_unknown',
    reported_cost_usd: null,
    reported_cost_source: null,
    output_tokens_includes_reasoning: null,
    prior_estimated_cost_usd: null,
    prior_cost_status: null,
    prior_cost_source: null,
    prior_pricing_version: null,
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
    cost_source: 'legacy_unknown',
    top_project_by_cost: 'unknown',
    top_project_cost_usd: 0,
    top_model_by_cost: 'unknown',
    top_model_cost_usd: 0,
    prior_estimated_cost_usd: null,
    prior_cost_status: null,
    prior_cost_source: null,
    prior_pricing_version: null,
    ...overrides,
  };
}

describe('historical cost recalculation plan', () => {
  it('builds a read-only legacy-schema preview with explicit unknown provenance defaults', () => {
    const query = buildCompatibleSelect(
      'daily_usage_breakdown',
      new Set(['device_id', 'usage_date', 'provider', 'estimated_cost_usd']),
      ['device_id', 'usage_date', { name: 'cost_source', fallbackSql: "'legacy_unknown'" }],
      " WHERE usage_date >= '2026-01-01'",
    );
    expect(query).toBe("SELECT device_id, usage_date, 'legacy_unknown' AS cost_source FROM daily_usage_breakdown WHERE usage_date >= '2026-01-01'");
    expect(() => buildCompatibleSelect('daily_usage', new Set(), ['device_id'])).toThrow(/缺少必要列/);
    expect(() => buildCompatibleSelect('daily_usage; DROP TABLE x', new Set(), [])).toThrow(/表名无效/);
  });

  it('limits a scoped reprice to selected device/product/model and recomputes full daily totals', () => {
    const target = breakdown({
      device_id: 'sakur',
      provider: 'openai-codex',
      product: 'pi',
      model: 'gpt-5.6-luna',
      input_tokens: 100_000,
      output_tokens: 100_000,
      estimated_cost_usd: 7,
      extra_metrics_json: JSON.stringify({ raw_providers: ['openai-codex'] }),
    });
    const otherProduct = breakdown({
      device_id: 'sakur',
      provider: 'opencode',
      product: 'opencode',
      model: 'unlisted-model',
      input_tokens: 100,
      output_tokens: 50,
      estimated_cost_usd: 1,
    });
    const otherDevice = breakdown({
      device_id: 'fn-device',
      provider: 'openai-codex',
      product: 'pi',
      model: 'gpt-5.6-luna',
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      estimated_cost_usd: 8,
    });
    const unverifiedGatewayRoute = breakdown({
      device_id: 'sakur',
      provider: 'openai',
      product: 'pi',
      model: 'gpt-5.6-luna',
      estimated_cost_usd: 0,
      cost_status: 'unavailable',
      extra_metrics_json: JSON.stringify({ raw_providers: ['opencode-go'] }),
    });
    const plan = buildRecalculationPlan(
      [target, otherProduct, otherDevice, unverifiedGatewayRoute],
      [daily({ device_id: 'sakur', estimated_cost_usd: 8 }), daily({ device_id: 'fn-device', estimated_cost_usd: 8 })],
      {
        from: '2026-08-01',
        to: '2026-08-01',
        scope: {
          deviceIds: ['sakur'], products: ['pi'], models: ['gpt-5.6-luna'],
          rawProviders: ['openai-codex'],
        },
      },
    );

    expect(plan.breakdowns.map(update => [update.estimatedCostUsd, update.changed])).toEqual([
      [0.14, true],
      [1, false],
      [8, false],
      [0, false],
    ]);
    expect(plan.daily.map(update => [update.estimatedCostUsd, update.changed])).toEqual([
      [1.14, true],
      [8, false],
    ]);
    expect(plan.summary.costDeltaUsd).toBe(-6.86);
    expect(plan.summary.rowsChanged).toBe(1);
    expect(plan.summary.dailyRowsChanged).toBe(1);
    expect(plan.summary.modelCostChanges).toEqual([
      expect.objectContaining({ model: 'gpt-5.6-luna', rows: 1, totalTokens: 200_000, beforeCostUsd: 7, afterCostUsd: 0.14 }),
    ]);
  });

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

    expect(plan.breakdowns[0]).toMatchObject({ estimatedCostUsd: 2.2, costStatus: 'estimated', changed: true });
    expect(plan.breakdowns[1]).toMatchObject({ estimatedCostUsd: 0, costStatus: 'unavailable', changed: true });
    expect(plan.daily[0]).toMatchObject({
      estimatedCostUsd: 2.2,
      costStatus: 'unavailable',
      topModel: 'gpt-5.6-luna',
      topProjectCostUsd: 2.2,
      changed: true,
    });
    expect(plan.summary.before).toEqual({
      totalEvents: 2,
      totalTokens: 2_000_150,
      totalCostUsd: 0,
      costBearingEvents: 0,
      coveredTokens: 0,
      unpricedTokens: 2_000_150,
      legacyUnknownTokens: 0,
      explicitFreeTokens: 0,
      clientReportedEstimateUsd: 0,
      coveragePercent: 0,
    });
    expect(plan.summary.after).toEqual({
      totalEvents: 2,
      totalTokens: 2_000_150,
      totalCostUsd: 2.2,
      costBearingEvents: 1,
      coveredTokens: 2_000_000,
      unpricedTokens: 150,
      legacyUnknownTokens: 0,
      explicitFreeTokens: 0,
      clientReportedEstimateUsd: 0,
      coveragePercent: 99.9925,
    });
    expect(plan.summary.modelsStillUnavailable).toEqual([
      expect.objectContaining({ provider: 'opencode', product: 'opencode', model: 'hy3-free', totalTokens: 150 }),
    ]);
    expect(JSON.stringify(plan.summary)).not.toContain('/secret/');
    expect(snapshotTokenFacts(beforeBreakdowns, beforeDaily)).toBe(beforeFacts);
  });

  it('keeps a single recorded gateway route instead of inferring the vendor from the model name', () => {
    const row = breakdown({
      provider: 'openai',
      product: 'pi',
      model: 'gpt-5.6-luna',
      extra_metrics_json: JSON.stringify({ raw_providers: ['opencode-go'] }),
    });
    const plan = buildRecalculationPlan([row], [daily()]);

    expect(plan.breakdowns[0]).toMatchObject({
      estimatedCostUsd: 2.2,
      costStatus: 'estimated',
      costSource: 'catalog_estimate',
    });
  });

  it('uses a single explicit provider alias retained in historical metadata', () => {
    const row = breakdown({
      provider: 'openai',
      product: 'pi',
      model: 'gpt-5.6-luna',
      extra_metrics_json: JSON.stringify({ raw_providers: ['openai-codex'] }),
    });
    const plan = buildRecalculationPlan([row], [daily()]);

    expect(plan.breakdowns[0]).toMatchObject({
      estimatedCostUsd: 2.2,
      costStatus: 'estimated',
      costSource: 'catalog_estimate',
    });
  });

  it('does not choose the first price route when a historical row has mixed raw providers', () => {
    const row = breakdown({
      provider: 'openai',
      product: 'pi',
      model: 'gpt-5.6-luna',
      extra_metrics_json: JSON.stringify({ raw_providers: ['openai-codex', 'opencode-go'] }),
    });
    const plan = buildRecalculationPlan([row], [daily()]);

    expect(plan.breakdowns[0]).toMatchObject({
      estimatedCostUsd: 0,
      costStatus: 'unavailable',
      costSource: 'unavailable',
    });
  });

  it('reprices legacy OpenCode cost without treating it as supplier actual', () => {
    const row = breakdown({
      provider: 'openai',
      product: 'opencode',
      model: 'gpt-5.6-luna',
      estimated_cost_usd: 0.42,
      cost_status: 'exact',
    });
    const plan = buildRecalculationPlan([row], [daily()], {});

    expect(plan.breakdowns[0]).toMatchObject({ estimatedCostUsd: 2.2, costStatus: 'estimated', costSource: 'catalog_estimate', changed: true });
  });

  it('is idempotent after one recalculation pass', () => {
    const inputBreakdown = breakdown({
      provider: 'openai', product: 'codex', model: 'gpt-6.1-sol',
      input_tokens: 100_000, output_tokens: 40_000, reasoning_output_tokens: 10_000,
    });
    const inputDaily = daily({ event_count: 1, input_tokens: 100_000, output_tokens: 40_000, reasoning_output_tokens: 10_000 });
    const first = buildRecalculationPlan([inputBreakdown], [inputDaily]);
    const appliedBreakdown = first.breakdowns.map(update => ({
      ...update.row,
      estimated_cost_usd: update.estimatedCostUsd,
      cost_status: update.costStatus,
      cost_source: update.costSource,
      pricing_version: update.pricingVersion,
    }));
    const appliedDaily = first.daily.map(update => ({
      ...update.row,
      estimated_cost_usd: update.estimatedCostUsd,
      cost_status: update.costStatus,
      cost_source: update.costSource,
      pricing_version: update.pricingVersion,
      top_project_by_cost: update.topProject,
      top_project_cost_usd: update.topProjectCostUsd,
      top_model_by_cost: update.topModel,
      top_model_cost_usd: update.topModelCostUsd,
    }));
    const second = buildRecalculationPlan(appliedBreakdown, appliedDaily);

    expect(first.summary.rowsChanged).toBe(1);
    expect(first.summary.dailyRowsChanged).toBe(1);
    expect(second.summary.rowsChanged).toBe(0);
    expect(second.summary.dailyRowsChanged).toBe(0);
  });

  it.each([getPricingCatalog().version, 'previous-version'])('preserves per-request Codex costs and original version %s', version => {
    const row = breakdown({
      provider: 'openai', product: 'codex', model: 'gpt-6.1-terra', event_count: 2,
      input_tokens: 320_000, output_tokens: 3_000, reasoning_output_tokens: 0,
      estimated_cost_usd: 0.6225, cost_status: 'estimated', cost_source: 'catalog_estimate',
      pricing_version: version, output_tokens_includes_reasoning: 0,
      extra_metrics_json: JSON.stringify({ cost_evidence: 'unknown', cost_granularity: 'per_request' }),
    });
    const plan = buildRecalculationPlan([row], [daily({
      event_count: 2, input_tokens: 320_000, output_tokens: 3_000, reasoning_output_tokens: 0,
      estimated_cost_usd: 0.6225, cost_status: 'estimated', cost_source: 'catalog_estimate',
      pricing_version: getPricingCatalog().version,
    })]);

    expect(plan.breakdowns[0]).toMatchObject({
      pricingVersion: version,
      estimatedCostUsd: 0.6225,
      costStatus: 'estimated',
      costSource: 'catalog_estimate',
      changed: false,
    });
    expect(plan.summary.after.totalCostUsd).toBe(0.6225);
  });

  it('reprices legacy Codex reasoning as already included in output and preserves token counts', () => {
    const row = breakdown({
      provider: 'openai', product: 'codex', model: 'gpt-6.1-sol',
      input_tokens: 100_000, output_tokens: 100_000, reasoning_output_tokens: 30_000,
      cost_status: 'exact', cost_source: 'legacy_unknown',
    });
    const day = daily({
      event_count: 1, input_tokens: 100_000, output_tokens: 100_000, reasoning_output_tokens: 30_000,
      cost_status: 'exact', cost_source: 'legacy_unknown',
    });
    const plan = buildRecalculationPlan([row], [day]);
    expect(plan.breakdowns[0]).toMatchObject({ estimatedCostUsd: 1.2, costStatus: 'estimated' });
    expect(plan.summary.before).toMatchObject({ totalTokens: 200_000, legacyUnknownTokens: 200_000, unpricedTokens: 0 });
    expect(plan.summary.after.totalTokens).toBe(200_000);
    expect(plan.summary.after.unpricedTokens).toBe(0);
  });

  it('does not trust legacy Fast suffixes without per-request tier evidence', () => {
    const row = breakdown({
      provider: 'openai', product: 'codex', model: 'gpt-6.1-sol-fast',
      input_tokens: 100_000, output_tokens: 100_000, reasoning_output_tokens: 0,
      cost_status: 'exact', cost_source: 'legacy_unknown',
    });
    const plan = buildRecalculationPlan([row], [daily()], {});
    expect(plan.breakdowns[0]).toMatchObject({ estimatedCostUsd: 1.2, costStatus: 'estimated' });
  });

  it('does not promote a positive legacy OpenCode amount to supplier actual', () => {
    const row = breakdown({
      provider: 'openai', product: 'opencode', model: 'openai/pi/codex/gpt-6.1-sol',
      estimated_cost_usd: 0.42, cost_status: 'exact', cost_source: 'legacy_unknown',
    });
    const plan = buildRecalculationPlan([row], [daily({ estimated_cost_usd: 0.42 })]);
    expect(plan.breakdowns[0]).toMatchObject({
      estimatedCostUsd: 0,
      costStatus: 'unavailable',
      costSource: 'unavailable',
      changed: true,
    });
  });

  it('generates cost-only SQL and never writes token columns', () => {
    const plan = buildRecalculationPlan([breakdown()], [daily()], {});
    const sql = buildSqlBatch(plan, '2026-08-01', '2026-08-23T12:00:00.000Z');

    expect(sql).toContain('estimated_cost_usd');
    expect(sql).toContain('pricing_version');
    expect(sql).toContain('prior_estimated_cost_usd = COALESCE(prior_estimated_cost_usd, estimated_cost_usd)');
    expect(sql).toContain('prior_cost_source = COALESCE(prior_cost_source, cost_source)');
    expect(sql).not.toContain('BEGIN;');
    expect(sql).not.toContain('COMMIT;');
    expect(sql).not.toMatch(/input_tokens|cached_input_tokens|cache_write_tokens|output_tokens|reasoning_output_tokens/);
    expect(sql).toContain("cost_source = 'catalog_estimate'");
  });
});
