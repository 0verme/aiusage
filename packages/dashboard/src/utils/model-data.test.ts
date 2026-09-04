import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mergeModelFacetOptions,
  mergeModelShareItems,
  normalizeModelDimensions,
} from './data';
import type { OverviewPayload } from '../hooks/use-overview';

test('merges model share metrics without recalculating cost', () => {
  const result = mergeModelShareItems([
    {
      value: 'GLM-5.3-Flash',
      label: 'GLM-5.3-Flash',
      estimatedCostUsd: 10,
      eventCount: 2,
      totalTokens: 100,
    },
    {
      value: 'glm_5.3_flash',
      label: 'glm_5.3_flash',
      estimatedCostUsd: 20,
      eventCount: 3,
      totalTokens: 200,
    },
  ]);

  assert.deepEqual(result, [{
    value: 'glm-5.3-flash',
    label: 'GLM-5.3 Flash',
    estimatedCostUsd: 30,
    eventCount: 5,
    totalTokens: 300,
    rawModels: ['glm_5.3_flash', 'GLM-5.3-Flash'],
    aliasCount: 2,
  }]);
});

test('merges model facet options and keeps raw aliases for hover inspection', () => {
  const result = mergeModelFacetOptions([
    {
      value: 'DeepSeek-V4-Flash-0731',
      label: 'DeepSeek-V4-Flash-0731',
      estimatedCostUsd: 1,
      eventCount: 1,
    },
    {
      value: 'deepseek-v4-flash',
      label: 'deepseek-v4-flash',
      estimatedCostUsd: 2,
      eventCount: 4,
    },
  ]);

  assert.deepEqual(result, [{
    value: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    estimatedCostUsd: 3,
    eventCount: 5,
    rawModels: ['deepseek-v4-flash', 'DeepSeek-V4-Flash-0731'],
    aliasCount: 2,
  }]);
});

test('normalizes legacy Sankey model nodes while preserving project flow totals', () => {
  const overview = {
    modelCostShare: [
      { value: 'GLM-5.3-Flash', label: 'GLM-5.3-Flash', estimatedCostUsd: 10, eventCount: 1, totalTokens: 100 },
      { value: 'glm-5.3-flash', label: 'glm-5.3-flash', estimatedCostUsd: 20, eventCount: 2, totalTokens: 200 },
    ],
    sankey: {
      nodes: [
        { id: 'model-GLM-5.3-Flash', label: 'GLM-5.3-Flash', layer: 0, totalTokens: 100 },
        { id: 'model-glm-5.3-flash', label: 'glm-5.3-flash', layer: 0, totalTokens: 200 },
        { id: 'project-demo', label: 'demo', layer: 1, totalTokens: 300 },
      ],
      links: [
        { source: 'model-GLM-5.3-Flash', target: 'project-demo', value: 100 },
        { source: 'model-glm-5.3-flash', target: 'project-demo', value: 200 },
      ],
    },
    filters: {
      selection: { range: 'all', deviceId: [], provider: [], product: [], channel: [], model: [], project: [] },
      options: { devices: [], providers: [], products: [], channels: [], models: [], projects: [] },
    },
  } as unknown as OverviewPayload;

  const result = normalizeModelDimensions(overview);
  assert.equal(result.sankey.nodes.filter((node) => node.layer === 0).length, 1);
  assert.equal(result.sankey.nodes.find((node) => node.layer === 0)?.totalTokens, 300);
  assert.deepEqual(result.sankey.links, [{ source: 'model-glm-5.3-flash', target: 'project-demo', value: 300 }]);
  assert.equal(result.modelCostShare[0]?.estimatedCostUsd, 30);
});
