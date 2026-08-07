import assert from 'node:assert/strict';
import test from 'node:test';
import { getSharePercent, prepareShareItems, scaleModelShares } from './share-data';

test('sorts model share by tokens instead of cost-derived order', () => {
  const result = prepareShareItems([
    { value: 'gpt', label: 'GPT', amount: 2_000 },
    { value: 'deepseek', label: 'DeepSeek', amount: 9_000 },
  ]);

  assert.deepEqual(result.map((item) => item.value), ['deepseek', 'gpt']);
  assert.equal(getSharePercent(result[0].amount, 11_000).toFixed(1), '81.8');
});

test('keeps provider and device shares ordered by their supplied cost amounts', () => {
  const result = prepareShareItems([
    { value: 'cheap', label: 'Cheap', amount: 1.8 },
    { value: 'expensive', label: 'Expensive', amount: 176 },
  ]);

  assert.deepEqual(result.map((item) => item.value), ['expensive', 'cheap']);
});

test('keeps a single positive item and drops zero-token items', () => {
  const result = prepareShareItems([
    { value: 'zero', label: 'Zero', amount: 0 },
    { value: 'only', label: 'Only', amount: 42 },
  ]);

  assert.deepEqual(result, [{ value: 'only', label: 'Only', amount: 42 }]);
  assert.deepEqual(prepareShareItems([{ value: 'zero', label: 'Zero', amount: 0 }]), []);
  assert.equal(getSharePercent(0, 0), 0);
});

test('keeps the five largest items and folds the rest into Other', () => {
  const result = prepareShareItems([
    { value: 'a', label: 'A', amount: 70 },
    { value: 'b', label: 'B', amount: 60 },
    { value: 'c', label: 'C', amount: 50 },
    { value: 'd', label: 'D', amount: 40 },
    { value: 'e', label: 'E', amount: 30 },
    { value: 'f', label: 'F', amount: 20 },
    { value: 'g', label: 'G', amount: 10 },
  ]);

  assert.equal(result.length, 6);
  assert.deepEqual(result.slice(0, 5).map((item) => item.value), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(result[5], { value: 'other', label: 'Other', amount: 30 });
});

test('scales current-month model cost and tokens with their matching ratios', () => {
  const [result] = scaleModelShares([{
    value: 'deepseek',
    label: 'DeepSeek',
    estimatedCostUsd: 10,
    eventCount: 20,
    totalTokens: 1_000,
  }], 0.25, 0.6);

  assert.equal(result.estimatedCostUsd, 2.5);
  assert.equal(result.totalTokens, 600);
  assert.equal(result.eventCount, 20);
});
