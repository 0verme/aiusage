import type { Locale } from '../i18n';
import { displayModelName } from '@aiusage/shared';
import { convertUsd, type CurrencyMode } from '../hooks/use-cny-rate';

export function formatUsd(v: number, currency: CurrencyMode = 'auto'): string {
  const { value: n, prefix } = convertUsd(Number(v || 0), currency);
  if (n >= 100) return `${prefix}${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  if (n >= 10) return `${prefix}${n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`;
  return `${prefix}${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatUsdFull(v: number, currency: CurrencyMode = 'auto'): string {
  const { value: n, prefix } = convertUsd(Number(v || 0), currency);
  return `${prefix}${n.toFixed(2)}`;
}

export function formatCompact(v: number, locale: Locale = 'en'): string {
  const n = Number(v || 0);
  if (locale === 'zh') {
    if (n >= 1e8) return `${(n / 1e8).toFixed(1)} 亿`;
    if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万`;
    return String(Math.round(n));
  }
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

export function formatNumber(v: number): string {
  return new Intl.NumberFormat('en-US').format(Number(v || 0));
}

/** Tooltip 用：紧凑数字 + 括号完整数字。如 `8.62B (8,621,971,144)`。
 *  数字 < 1000 时只显示原值，避免冗余如 `42 (42)`。 */
export function formatTokens(v: number, locale: Locale = 'en'): string {
  const n = Number(v || 0);
  if (n < 1000) return formatNumber(n);
  return `${formatCompact(n, locale)} (${formatNumber(n)})`;
}

export function formatPercent(v: number): string {
  return `${Number(v || 0).toFixed(1)}%`;
}

export function formatModelName(raw: string, compact = false): string {
  const display = displayModelName(raw);
  return compact ? display.replace(/^Claude\s+/i, '') : display;
}

export function shortDate(v: string): string { return v.slice(5); }

export function longDate(v: string): string {
  const d = new Date(v + 'T00:00:00');
  return Number.isNaN(d.getTime())
    ? v
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function arrSum(arr: number[]): number {
  return arr.reduce((a, b) => a + Number(b || 0), 0);
}
