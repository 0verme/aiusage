import { describe, expect, it } from 'vitest';
import {
  buildModelAggregationQuery,
  buildSankey,
  buildSankeyQuery,
  buildWhere,
  parseFilters,
} from './overview.js';
import { buildBreakdownQuery } from './breakdowns.js';
import { canonicalizeModel } from '@aiusage/shared';
import {
  mergeCanonicalModelRows,
  selectCanonicalModelValues,
} from '../utils/model-aggregation.js';
import {
  assertDashboardQuerySize,
  MAX_DASHBOARD_QUERY_BYTES,
  sqlUtf8Bytes,
} from '../utils/sql.js';
import type { Env } from '../types.js';

const plainEnv = { PUBLIC_PROJECT_VISIBILITY: 'plain' } as unknown as Env;

describe('canonical model aggregation', () => {
  it('merges syntax variants and explicit aliases without changing metrics', () => {
    const result = mergeCanonicalModelRows([
      {
        model: 'DeepSeek-V4-Flash-0731',
        estimatedCostUsd: 1.25,
        eventCount: 2,
        totalTokens: 100,
      },
      {
        model: 'deepseek-v4-flash',
        estimatedCostUsd: 2.5,
        eventCount: 3,
        totalTokens: 200,
      },
      {
        model: 'DEEPSEEK_V4_FLASH',
        estimatedCostUsd: 3.75,
        eventCount: 4,
        totalTokens: 300,
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      value: 'deepseek-v4-flash',
      estimatedCostUsd: 7.5,
      eventCount: 9,
      totalTokens: 600,
    });
    expect(result[0]?.rawModels).toEqual(expect.arrayContaining([
      'DeepSeek-V4-Flash-0731',
      'DEEPSEEK_V4_FLASH',
      'deepseek-v4-flash',
    ]));
  });

  it('merges known provider prefixes but keeps unknown namespaces', () => {
    expect(canonicalizeModel('anthropic/claude-opus-4.8-coding'))
      .toBe('claude-opus-4.8-coding');
    expect(canonicalizeModel('foo/custom-model')).toBe('foo/custom-model');

    const result = mergeCanonicalModelRows([
      { model: 'anthropic/claude-opus-4.8-coding', totalTokens: 10 },
      { model: 'claude-opus-4.8-coding', totalTokens: 20 },
      { model: 'foo/custom-model', totalTokens: 30 },
    ]);

    expect(result.map((row) => [row.value, row.totalTokens])).toEqual([
      ['claude-opus-4.8-coding', 30],
      ['foo/custom-model', 30],
    ]);
  });

  it('keeps raw model values independent when alias merging is disabled', () => {
    const result = mergeCanonicalModelRows([
      { model: 'DeepSeek-V4-Flash-0731', totalTokens: 100 },
      { model: 'deepseek-v4-flash', totalTokens: 200 },
    ], false);

    expect(result.map((row) => row.value)).toEqual([
      'deepseek-v4-flash',
      'DeepSeek-V4-Flash-0731',
    ]);
  });

  it('resolves canonical filter values against all matching historical database models', () => {
    const values = selectCanonicalModelValues([
      'DeepSeek-V4-Flash-0731',
      'deepseek-v4-flash',
      'DEEPSEEK_V4_FLASH',
      'foo/custom-model',
    ], ['deepseek-v4-flash']);

    expect(values).toHaveLength(3);
    expect(values).toEqual(expect.arrayContaining([
      'DeepSeek-V4-Flash-0731',
      'deepseek-v4-flash',
      'DEEPSEEK_V4_FLASH',
    ]));
  });

  it('keeps canonical and raw filter modes distinct', () => {
    const merged = parseFilters(new URL(
      'https://example.com/api/v1/public/overview?range=all&model=DeepSeek-V4-Flash-0731',
    ))!;
    expect(merged.mergeModelAliases).toBe(true);
    expect(merged.model).toEqual(['deepseek-v4-flash']);
    expect(buildWhere({
      ...merged,
      modelDatabaseValues: ['DeepSeek-V4-Flash-0731', 'deepseek-v4-flash'],
    }).whereClause).toContain('b.model IN (?, ?)');

    const raw = parseFilters(new URL(
      'https://example.com/api/v1/public/overview?range=all&mergeModelAliases=0&model=DeepSeek-V4-Flash-0731',
    ))!;
    expect(raw.mergeModelAliases).toBe(false);
    expect(raw.model).toEqual(['DeepSeek-V4-Flash-0731']);
    expect(buildWhere(raw).whereClause).toContain('json_extract');
  });

  it('keeps Sankey aliases merged at the Worker aggregation boundary', async () => {
    const result = await buildSankey([
      { model: 'anthropic/claude-opus-4.8-coding', project: 'demo', total_tokens: 100 },
      { model: 'claude-opus-4.8-coding', project: 'demo', total_tokens: 200 },
    ], plainEnv);

    expect(result.nodes.filter((node) => node.layer === 0)).toEqual([
      expect.objectContaining({
        id: 'model-claude-opus-4.8-coding',
        totalTokens: 300,
        aliasCount: 2,
      }),
    ]);
    expect(result.links).toEqual([
      { source: 'model-claude-opus-4.8-coding', target: 'project-demo', value: 300 },
    ]);
  });
});

describe('Dashboard SQL size guard', () => {
  it('builds model and Sankey queries without canonical CASE expansion', () => {
    const modelSql = buildModelAggregationQuery('WHERE b.usage_date >= ?', true);
    const sankeySql = buildSankeyQuery('WHERE b.usage_date >= ?', true);
    const breakdownSql = buildBreakdownQuery(
      'WHERE b.usage_date >= ?',
      true,
      'model',
      'DESC',
    );

    expect(modelSql).toContain('GROUP BY b.model');
    expect(modelSql).not.toContain('GROUP BY (CASE');
    expect(sqlUtf8Bytes(modelSql)).toBeLessThan(MAX_DASHBOARD_QUERY_BYTES);
    expect(sqlUtf8Bytes(sankeySql)).toBeLessThan(MAX_DASHBOARD_QUERY_BYTES);
    expect(sqlUtf8Bytes(breakdownSql)).toBeLessThan(MAX_DASHBOARD_QUERY_BYTES);
  });

  it('rejects a query above the internal UTF-8 byte limit', () => {
    expect(() => assertDashboardQuerySize(
      'test',
      'x'.repeat(MAX_DASHBOARD_QUERY_BYTES + 1),
    )).toThrow(/exceeds/);
  });
});
