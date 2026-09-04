import assert from 'node:assert/strict';
import test from 'node:test';
import { buildQuery, pivotProviderTrend } from './data';

test('serializes multi-select dashboard filters as repeated API parameters', () => {
  const query = buildQuery({
    range: '30d',
    deviceIds: ['mac-a', 'mac-b'],
    products: ['codex', 'claude-code'],
    models: ['gpt-5.6-sol'],
  });
  const params = new URLSearchParams(query);

  assert.deepEqual(params.getAll('deviceId'), ['mac-a', 'mac-b']);
  assert.deepEqual(params.getAll('product'), ['codex', 'claude-code']);
  assert.deepEqual(params.getAll('model'), ['gpt-5.6-sol']);
  assert.equal(params.get('range'), '30d');
  assert.equal(params.get('all'), null);
});

test('merges provider aliases in the trend pivot', () => {
  const result = pivotProviderTrend(
    [{ usageDate: '2026-08-20', eventCount: 3, estimatedCostUsd: 15 }],
    [
      { usageDate: '2026-08-20', provider: 'openai', estimatedCostUsd: 10 },
      { usageDate: '2026-08-20', provider: 'openai-codex', estimatedCostUsd: 5 },
    ],
  );

  assert.deepEqual(result.providers, ['openai']);
  assert.equal(result.data[0].openai, 15);
});

test('serializes the raw model debug switch without changing the default query', () => {
  assert.equal(new URLSearchParams(buildQuery({
    range: 'all',
    deviceIds: [],
    products: [],
    models: [],
    mergeModelAliases: false,
  })).get('mergeModelAliases'), '0');
  assert.equal(new URLSearchParams(buildQuery({
    range: 'all',
    deviceIds: [],
    products: [],
    models: [],
    mergeModelAliases: true,
  })).get('mergeModelAliases'), null);
});

test('omits empty selections so an empty array means no facet restriction', () => {
  const params = new URLSearchParams(buildQuery({
    range: '180d',
    deviceIds: [],
    products: [],
    models: [],
  }));

  assert.equal(params.toString(), 'range=180d');
});
