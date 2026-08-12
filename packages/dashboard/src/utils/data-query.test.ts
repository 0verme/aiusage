import assert from 'node:assert/strict';
import test from 'node:test';
import { buildQuery } from './data';

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
});
