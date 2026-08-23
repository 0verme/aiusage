import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('catalog.json exposes the public pricing catalog', async () => {
  let raw;
  try {
    raw = await readFile(new URL('../catalog.json', import.meta.url), 'utf-8');
  } catch (error) {
    assert.fail(`Unable to read catalog.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  const catalog = JSON.parse(raw);
  assert.match(catalog.version, /^\d{4}-\d{2}-\d{2}/);
  assert.ok(catalog.providers?.openai?.codex);
  assert.ok(catalog.providers?.anthropic?.['claude-code']);
  assert.equal(catalog.aliases?.['gpt-5.6'], 'gpt-5.6-sol');
  assert.equal(catalog.aliases?.['claude-fibre-5'], 'claude-fable-5');
  assert.equal(catalog.providers.anthropic['claude-code'].models['claude-opus-5']?.output_per_million, 25);
  assert.equal(catalog.providers.openai.codex.models['gpt-5.6-sol']?.input_per_million, 5);
  assert.equal(catalog.providers.xai['grok-build'].models['grok-4.5']?.tiers?.[0]?.output_per_million, 6);
  assert.equal(catalog.providers.xai['grok-build'].models['grok-4.6']?.tiers?.[1]?.cached_input_per_million, 1);
});
