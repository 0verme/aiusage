import { describe, expect, it } from 'vitest';
import type { Env } from '../types.js';
import { buildSankey, buildWhere, parseFilters } from './overview.js';

const plainEnv = { PUBLIC_PROJECT_VISIBILITY: 'plain' } as unknown as Env;

const aliasRows = [
  { model: 'GLM-5.3-Flash', project: 'demo', total_tokens: 100 },
  { model: 'glm_5.3_flash', project: 'demo', total_tokens: 200 },
  { model: 'DeepSeek-V4-Flash-0731', project: 'demo', total_tokens: 300 },
  { model: 'deepseek-v4-flash', project: 'demo', total_tokens: 400 },
];

describe('canonical model aggregation', () => {
  it('merges safe variants and explicit aliases in Sankey without changing token totals', async () => {
    const result = await buildSankey(aliasRows, plainEnv);

    expect(result.nodes.filter((node) => node.layer === 0)).toEqual([
      expect.objectContaining({
        id: 'model-deepseek-v4-flash',
        label: 'DeepSeek V4 Flash',
        totalTokens: 700,
        aliasCount: 2,
      }),
      expect.objectContaining({
        id: 'model-glm-5.3-flash',
        label: 'GLM-5.3 Flash',
        totalTokens: 300,
        aliasCount: 2,
      }),
    ]);
    expect(result.links).toEqual([
      { source: 'model-deepseek-v4-flash', target: 'project-demo', value: 700 },
      { source: 'model-glm-5.3-flash', target: 'project-demo', value: 300 },
    ]);
  });

  it('keeps raw filtering available behind the merge switch', () => {
    const merged = parseFilters(new URL(
      'https://example.com/api/v1/public/overview?range=all&model=DeepSeek-V4-Flash-0731',
    ))!;
    expect(merged.mergeModelAliases).toBe(true);
    expect(merged.model).toEqual(['deepseek-v4-flash']);
    expect(buildWhere(merged).whereClause).toContain('deepseek-v4-flash-0731');

    const raw = parseFilters(new URL(
      'https://example.com/api/v1/public/overview?range=all&mergeModelAliases=0&model=DeepSeek-V4-Flash-0731',
    ))!;
    expect(raw.mergeModelAliases).toBe(false);
    expect(raw.model).toEqual(['DeepSeek-V4-Flash-0731']);
    expect(buildWhere(raw).whereClause).toContain('json_extract');
  });
});
