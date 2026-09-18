import type { TokenCompositionItem } from '@aiusage/shared';

/** rolling 窗口：连续 7 天 Token 增量。 */
export const FASTEST_GROWTH_WINDOW_DAYS = 7;

const MS_PER_DAY = 86_400_000;

export type DailyTokenInput = Pick<TokenCompositionItem, 'usageDate' | 'totalTokens'>;

export interface CumulativeTokenPoint {
  usageDate: string;
  /** 当日 Token（无使用记录的日子为 0）。 */
  totalTokens: number;
  /** 从完整历史第一天累加到当日的 Token 总量，只可能持平或上涨。 */
  cumulativeTokens: number;
}

export interface FastestGrowthWindow {
  startDate: string;
  endDate: string;
  addedTokens: number;
  dailyAverageTokens: number;
  dayCount: number;
}

export interface CumulativeTokenSeriesData {
  points: CumulativeTokenPoint[];
  fastestGrowth: FastestGrowthWindow | null;
}

/** 把 YYYY-MM-DD 转成「自 epoch 起的天序号」，用 UTC 解析避免时区/夏令时跨天。 */
export function dayNumber(usageDate: string): number {
  return Math.round(Date.parse(`${usageDate}T00:00:00Z`) / MS_PER_DAY);
}

/** 天序号还原为 YYYY-MM-DD。 */
export function dateFromDayNumber(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

function toDailyMap(history: readonly DailyTokenInput[]): {
  dailyTokens: Map<number, number>;
  firstDay: number;
  lastDay: number;
} | null {
  const dailyTokens = new Map<number, number>();
  let firstDay = Number.POSITIVE_INFINITY;
  let lastDay = Number.NEGATIVE_INFINITY;

  for (const item of history) {
    const day = dayNumber(item?.usageDate ?? '');
    if (!Number.isFinite(day)) continue;
    // 负值与 NaN 一律按 0 处理，保证累计值单调不减。
    const tokens = Math.max(0, Number(item?.totalTokens) || 0);
    dailyTokens.set(day, (dailyTokens.get(day) ?? 0) + tokens);
    if (day < firstDay) firstDay = day;
    if (day > lastDay) lastDay = day;
  }

  if (!Number.isFinite(firstDay) || !Number.isFinite(lastDay)) return null;
  return { dailyTokens, firstDay, lastDay };
}

/**
 * 在完整历史（按日历天稠密化）上滑动 `windowDays` 天窗口，取 Token 增量最大的区间。
 * 少于一个完整窗口、或全程无增量时返回 null。
 */
export function findFastestGrowthWindow(
  dailyTokens: Map<number, number>,
  firstDay: number,
  lastDay: number,
  windowDays: number,
): FastestGrowthWindow | null {
  if (windowDays <= 0 || lastDay - firstDay + 1 < windowDays) return null;

  let windowSum = 0;
  for (let day = firstDay; day < firstDay + windowDays; day++) {
    windowSum += dailyTokens.get(day) ?? 0;
  }

  let bestSum = windowSum;
  let bestEnd = firstDay + windowDays - 1;
  for (let end = firstDay + windowDays; end <= lastDay; end++) {
    windowSum += dailyTokens.get(end) ?? 0;
    windowSum -= dailyTokens.get(end - windowDays) ?? 0;
    // 严格大于：并列时保留更早出现的区间，结果稳定可预测。
    if (windowSum > bestSum) {
      bestSum = windowSum;
      bestEnd = end;
    }
  }

  if (bestSum <= 0) return null;

  const startDay = bestEnd - windowDays + 1;
  return {
    startDate: dateFromDayNumber(startDay),
    endDate: dateFromDayNumber(bestEnd),
    addedTokens: bestSum,
    dailyAverageTokens: bestSum / windowDays,
    dayCount: windowDays,
  };
}

/**
 * 基于完整历史逐日 Token 派生「累计 Token」序列。
 *
 * - `history` 必须是完整历史（不受时间范围筛选影响），累计值因此永远从历史第一天起算。
 * - `windowDates` 只用来裁剪展示区间：区间第一天的累计值 = 该天之前的全部历史 + 当日。
 *   传入期间过滤后的日期时，区间外历史仍计入累计，不会重新归零。
 * - 输出按日期升序，且区间内每一天都保留一个数据点（缺数据的日子为 0，累计持平）。
 */
export function buildCumulativeTokenSeries({
  history,
  windowDates,
  growthWindowDays = FASTEST_GROWTH_WINDOW_DAYS,
}: {
  history: readonly DailyTokenInput[];
  windowDates?: readonly string[];
  growthWindowDays?: number;
}): CumulativeTokenSeriesData {
  const empty: CumulativeTokenSeriesData = { points: [], fastestGrowth: null };

  const windowDays = (windowDates ?? [])
    .map((date) => dayNumber(date))
    .filter((day) => Number.isFinite(day));
  // 没有任何历史数据时不上报累计值，交由上层展示空状态。
  const daily = toDailyMap(history);
  if (!daily) return empty;

  const { dailyTokens, firstDay, lastDay } = daily;

  const startDay = windowDays.length ? Math.min(...windowDays) : firstDay;
  const endDay = windowDays.length ? Math.max(...windowDays) : lastDay;
  if (!Number.isFinite(startDay) || !Number.isFinite(endDay) || endDay < startDay) return empty;

  // 从「历史起点」与「展示起点」中更早的一天开始累加，保证区间第一天的累计包含全部历史。
  const walkStart = Math.min(startDay, firstDay);
  const points: CumulativeTokenPoint[] = [];
  let cumulativeTokens = 0;

  for (let day = walkStart; day <= endDay; day++) {
    const tokens = dailyTokens.get(day) ?? 0;
    cumulativeTokens += tokens;
    if (day >= startDay) {
      points.push({
        usageDate: dateFromDayNumber(day),
        totalTokens: tokens,
        cumulativeTokens,
      });
    }
  }

  return {
    points,
    fastestGrowth: findFastestGrowthWindow(dailyTokens, firstDay, lastDay, growthWindowDays),
  };
}
