import type { ModelShareItem } from '@aiusage/shared';

export interface ShareChartItem {
  value: string;
  label: string;
  amount: number;
}

export function prepareShareItems<T extends ShareChartItem>(items: T[], limit = 6): T[] {
  const sorted = items
    .filter((item) => Number.isFinite(item.amount) && item.amount > 0)
    .sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label));

  if (sorted.length <= limit) return sorted;

  const head = sorted.slice(0, limit - 1);
  const tail = sorted.slice(limit - 1);
  const other = tail.reduce(
    (acc, item) => ({ ...acc, amount: acc.amount + item.amount }),
    { ...tail[0], value: 'other', label: 'Other', amount: 0 },
  );

  return [...head, other];
}

export function getSharePercent(amount: number, total: number): number {
  return total > 0 ? (amount / total) * 100 : 0;
}

export function scaleModelShares(
  items: ModelShareItem[],
  costRatio: number,
  tokenRatio: number,
): ModelShareItem[] {
  return items.map((item) => ({
    ...item,
    estimatedCostUsd: +(item.estimatedCostUsd * costRatio).toFixed(4),
    totalTokens: Math.round(item.totalTokens * tokenRatio),
  }));
}
