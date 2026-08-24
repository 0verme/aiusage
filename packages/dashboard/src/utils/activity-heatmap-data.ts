import type { DailyTrendItem, HeatmapDay } from '@aiusage/shared';

export const ACTIVITY_HEATMAP_WEEKS = 53;

export interface ActivityHeatmapDay {
  usageDate: string;
  activityValue: number;
  estimatedCostUsd: number;
  totalTokens: number;
  eventCount: number;
}

export interface ActivityHeatmapData {
  metricLabel: 'tokens' | 'sessions';
  days: ActivityHeatmapDay[];
}

function toLocalDateString(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function addLocalDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

export function calculateActivityStreak(days: ActivityHeatmapDay[], today = new Date()): number {
  const activityByDate = new Map(days.map(day => [day.usageDate, day.activityValue]));
  const todayActivity = activityByDate.get(toLocalDateString(today)) ?? 0;
  const startOffset = todayActivity > 0 ? 0 : 1;
  let streak = 0;

  for (let offset = startOffset; ; offset++) {
    const activity = activityByDate.get(toLocalDateString(addLocalDays(today, -offset))) ?? 0;
    if (activity <= 0) break;
    streak++;
  }

  return streak;
}

export function calculateLongestActivityStreak(
  days: ActivityHeatmapDay[],
  startDate: Date,
  endDate = new Date(),
): number {
  const activityByDate = new Map(days.map(day => [day.usageDate, day.activityValue]));
  const start = new Date(startDate);
  const end = new Date(endDate);
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);

  let longestStreak = 0;
  let currentStreak = 0;
  for (let date = start; date <= end; date = addLocalDays(date, 1)) {
    const activity = activityByDate.get(toLocalDateString(date)) ?? 0;
    if (activity > 0) {
      currentStreak++;
      longestStreak = Math.max(longestStreak, currentStreak);
    } else {
      currentStreak = 0;
    }
  }

  return longestStreak;
}

export function buildActivityHeatmapData({
  heatmap,
  dailyTrend,
  tokenMetricsUnavailable,
}: {
  heatmap: HeatmapDay[];
  dailyTrend: DailyTrendItem[];
  tokenMetricsUnavailable: boolean;
}): ActivityHeatmapData {
  const heatmapByDate = new Map(heatmap.map((day) => [day.usageDate, day]));
  const trendByDate = new Map(dailyTrend.map((day) => [day.usageDate, day]));
  const usageDates = Array.from(new Set([
    ...heatmap.map((day) => day.usageDate),
    ...dailyTrend.map((day) => day.usageDate),
  ])).sort();

  const days = usageDates.map((usageDate) => {
    const heat = heatmapByDate.get(usageDate);
    const trend = trendByDate.get(usageDate);
    const totalTokens = heat?.totalTokens ?? 0;
    const eventCount = trend?.eventCount ?? 0;

    return {
      usageDate,
      activityValue: tokenMetricsUnavailable ? eventCount : totalTokens,
      estimatedCostUsd: heat?.estimatedCostUsd ?? trend?.estimatedCostUsd ?? 0,
      totalTokens,
      eventCount,
    };
  });

  return {
    metricLabel: tokenMetricsUnavailable ? 'sessions' : 'tokens',
    days,
  };
}
