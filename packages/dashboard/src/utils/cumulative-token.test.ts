import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FASTEST_GROWTH_WINDOW_DAYS,
  buildCumulativeTokenSeries,
  findFastestGrowthWindow,
  type DailyTokenInput,
} from './cumulative-token';

function days(entries: [string, number][]): DailyTokenInput[] {
  return entries.map(([usageDate, totalTokens]) => ({ usageDate, totalTokens }));
}

test('accumulates daily tokens into a running total', () => {
  const result = buildCumulativeTokenSeries({
    history: days([
      ['2026-09-01', 1e8],
      ['2026-09-02', 2e8],
      ['2026-09-03', 5e8],
      ['2026-09-04', 8e8],
    ]),
  });

  assert.deepEqual(result.points.map((p) => p.cumulativeTokens), [1e8, 3e8, 8e8, 16e8]);
  assert.deepEqual(result.points.map((p) => p.totalTokens), [1e8, 2e8, 5e8, 8e8]);
});

test('sorts unsorted input by date', () => {
  const result = buildCumulativeTokenSeries({
    history: days([
      ['2026-09-03', 5],
      ['2026-09-01', 1],
      ['2026-09-02', 2],
    ]),
  });

  assert.deepEqual(result.points.map((p) => p.usageDate), ['2026-09-01', '2026-09-02', '2026-09-03']);
  assert.deepEqual(result.points.map((p) => p.cumulativeTokens), [1, 3, 8]);
});

test('returns an empty series for empty history without throwing', () => {
  assert.deepEqual(buildCumulativeTokenSeries({ history: [] }), { points: [], fastestGrowth: null });
  assert.deepEqual(buildCumulativeTokenSeries({ history: [], windowDates: ['2026-09-01'] }).points, []);
});

test('keeps a single day of data working', () => {
  const result = buildCumulativeTokenSeries({ history: days([['2026-09-01', 42]]) });

  assert.equal(result.points.length, 1);
  assert.equal(result.points[0]?.cumulativeTokens, 42);
  assert.equal(result.fastestGrowth, null);
});

test('never decreases across gap days, duplicate rows and invalid values', () => {
  const result = buildCumulativeTokenSeries({
    history: days([
      ['2026-09-01', 10],
      ['2026-09-01', 5], // 同一天重复上报 → 合并
      ['2026-09-04', 7], // 中间缺 09-02 / 09-03 → 补 0
      ['2026-09-05', -3], // 异常负值 → 按 0 处理
      ['not-a-date', 999],
    ]),
  });

  assert.deepEqual(result.points.map((p) => p.usageDate), [
    '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05',
  ]);
  assert.deepEqual(result.points.map((p) => p.cumulativeTokens), [15, 15, 15, 22, 22]);
  for (let i = 1; i < result.points.length; i++) {
    assert.ok(result.points[i]!.cumulativeTokens >= result.points[i - 1]!.cumulativeTokens);
  }
});

test('last cumulative value equals the full-history total token sum', () => {
  const history = days([
    ['2026-03-01', 10],
    ['2026-07-01', 100],
    ['2026-09-04', 87.8],
  ]);
  const result = buildCumulativeTokenSeries({ history });

  assert.equal(result.points.at(-1)?.cumulativeTokens, 197.8);
});

test('window clipping keeps the full-history baseline instead of restarting at zero', () => {
  const history = days([
    ['2026-03-01', 10e8],
    ['2026-07-01', 90e8],
    ['2026-08-31', 65e8],
    ['2026-09-01', 16e8],
    ['2026-09-02', 16.8e8],
  ]);

  const result = buildCumulativeTokenSeries({
    history,
    windowDates: ['2026-09-01', '2026-09-02'],
  });

  assert.deepEqual(result.points.map((p) => p.usageDate), ['2026-09-01', '2026-09-02']);
  // 165 亿 → 197.8 亿，而不是 0 → 32.8 亿
  assert.equal(result.points[0]?.cumulativeTokens, 181e8);
  assert.equal(result.points[1]?.cumulativeTokens, 197.8e8);
});

test('densifies the visible window so every calendar day has a cumulative point', () => {
  const result = buildCumulativeTokenSeries({
    history: days([
      ['2026-08-01', 10],
      ['2026-09-01', 10],
    ]),
    windowDates: ['2026-09-01', '2026-09-03'],
  });

  assert.deepEqual(result.points.map((p) => p.usageDate), [
    '2026-09-01', '2026-09-02', '2026-09-03',
  ]);
  assert.deepEqual(result.points.map((p) => p.cumulativeTokens), [20, 20, 20]);
});

test('finds the maximum rolling 7-day growth window', () => {
  const history = days([
    // 平静期：每天 1
    ...Array.from({ length: 20 }, (_, i) => [`2026-08-${String(i + 1).padStart(2, '0')}`, 1] as [string, number]),
    // 高峰：08-29 ～ 09-04 共 28.6
    ['2026-08-29', 1],
    ['2026-08-30', 2],
    ['2026-08-31', 3],
    ['2026-09-01', 4],
    ['2026-09-02', 5],
    ['2026-09-03', 6],
    ['2026-09-04', 7.6],
    ['2026-09-05', 1],
  ]);

  const result = buildCumulativeTokenSeries({ history, growthWindowDays: 7 });
  assert.equal(result.fastestGrowth?.startDate, '2026-08-29');
  assert.equal(result.fastestGrowth?.endDate, '2026-09-04');
  assert.equal(result.fastestGrowth?.addedTokens, 28.6);
  assert.equal(result.fastestGrowth?.dailyAverageTokens, 28.6 / 7);
  assert.equal(result.fastestGrowth?.dayCount, 7);
});

test('measures the fastest growth window over the full history, not the visible window', () => {
  const history = days([
    ['2026-03-01', 10],
    ['2026-03-02', 10],
    ['2026-03-03', 10],
    ['2026-03-04', 10],
    ['2026-03-05', 10],
    ['2026-03-06', 10],
    ['2026-03-07', 10],
    ['2026-09-01', 1],
    ['2026-09-02', 1],
  ]);

  const result = buildCumulativeTokenSeries({
    history,
    windowDates: ['2026-09-01', '2026-09-02'],
  });

  assert.deepEqual(result.fastestGrowth, {
    startDate: '2026-03-01',
    endDate: '2026-03-07',
    addedTokens: 70,
    dailyAverageTokens: 10,
    dayCount: 7,
  });
});

test('degrades gracefully when there are fewer days than the rolling window', () => {
  const history = days([
    ['2026-09-01', 5],
    ['2026-09-02', 5],
    ['2026-09-03', 5],
  ]);

  const result = buildCumulativeTokenSeries({ history });
  assert.equal(result.fastestGrowth, null);
  assert.equal(result.points.length, 3);
  assert.equal(FASTEST_GROWTH_WINDOW_DAYS, 7);
});

test('returns no fastest window when the whole history has zero growth', () => {
  const history = days(Array.from({ length: 10 }, (_, i) => [
    `2026-09-${String(i + 1).padStart(2, '0')}`, 0,
  ] as [string, number]));

  assert.equal(buildCumulativeTokenSeries({ history }).fastestGrowth, null);
});

test('findFastestGrowthWindow keeps the earliest window on ties', () => {
  const dailyTokens = new Map<number, number>();
  const first = Math.round(Date.parse('2026-09-01T00:00:00Z') / 86_400_000);
  for (let i = 0; i < 10; i++) dailyTokens.set(first + i, 1);

  const result = findFastestGrowthWindow(dailyTokens, first, first + 9, 7);
  assert.equal(result?.startDate, '2026-09-01');
  assert.equal(result?.endDate, '2026-09-07');
  assert.equal(result?.addedTokens, 7);
});

test('exposes per-day tooltip values (daily + cumulative)', () => {
  const result = buildCumulativeTokenSeries({
    history: days([
      ['2026-09-01', 100e8],
      ['2026-09-02', 2e8],
      ['2026-09-03', 5.2e8],
    ]),
  });

  const sept3 = result.points[2];
  assert.equal(sept3?.usageDate, '2026-09-03');
  assert.equal(sept3?.totalTokens, 5.2e8);
  assert.equal(sept3?.cumulativeTokens, 107.2e8);
});
