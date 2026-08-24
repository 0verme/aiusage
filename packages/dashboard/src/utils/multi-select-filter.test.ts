import assert from 'node:assert/strict';
import test from 'node:test';
import { getMultiSelectSummary, toggleMultiSelectValue } from './multi-select-filter';

const options = [
  { value: 'gpt-5.6-sol', label: 'gpt-5-6-sol', eventCount: 64000 },
  { value: 'claude-opus-5', label: 'claude-opus-5', eventCount: 9685 },
];

test('shows the localized all label for an empty selection', () => {
  assert.equal(getMultiSelectSummary([], options, 'All', 'en'), 'All');
  assert.equal(getMultiSelectSummary([], options, '全部', 'zh'), '全部');
});

test('adds and removes one raw option value without changing its query value', () => {
  const selected = toggleMultiSelectValue([], 'gpt-5.6-sol');
  assert.deepEqual(selected, ['gpt-5.6-sol']);
  assert.equal(
    getMultiSelectSummary(selected, options, 'All', 'en', (_, value) => `formatted:${value}`),
    'formatted:gpt-5.6-sol',
  );
  assert.deepEqual(toggleMultiSelectValue(selected, 'gpt-5.6-sol'), []);
});

test('summarizes multiple selections instead of stacking labels in the trigger', () => {
  const selected = toggleMultiSelectValue(
    toggleMultiSelectValue([], 'gpt-5.6-sol'),
    'claude-opus-5',
  );

  assert.equal(getMultiSelectSummary(selected, options, 'All', 'en'), '2 selected');
  assert.equal(getMultiSelectSummary(selected, options, '全部', 'zh'), '2 项');
});
