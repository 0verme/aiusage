import type { ChartConfig } from './components/ui/chart';
import { LIGHT_PALETTE, DARK_PALETTE, getSeriesColors } from './palette';

// Token composition series — input(cyan) cached(blue) cacheWrite(violet) output(green) reasoning(grey)
export const TOKEN_SERIES = [
  { key: 'inputTokens' as const, label: 'Input', color: LIGHT_PALETTE.accent, darkColor: DARK_PALETTE.accent },
  { key: 'cachedInputTokens' as const, label: 'Cached', color: LIGHT_PALETTE.accent2, darkColor: DARK_PALETTE.accent2 },
  { key: 'cacheWriteTokens' as const, label: 'Cache Write', color: LIGHT_PALETTE.violet, darkColor: DARK_PALETTE.violet },
  { key: 'outputTokens' as const, label: 'Output', color: LIGHT_PALETTE.green, darkColor: DARK_PALETTE.green },
  { key: 'reasoningOutputTokens' as const, label: 'Reasoning', color: LIGHT_PALETTE.fg3, darkColor: DARK_PALETTE.fg3 },
];

export const CHART_COLORS = getSeriesColors(false);

export const CHART_COLORS_DARK = getSeriesColors(true);

export const PROVIDER_COLORS: Record<string, string> = {
  openai: DARK_PALETTE.accent,
  anthropic: DARK_PALETTE.orange,
  google: DARK_PALETTE.accent2,
  github: DARK_PALETTE.violet,
  sourcegraph: DARK_PALETTE.green,
  moonshot: '#ff5c8a',
  alibaba: '#ffc04d',
  droid: DARK_PALETTE.fg2,
  opencode: DARK_PALETTE.fg3,
  trae: '#7c3aed',
  zhipu: '#2563eb',
};

export const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  github: 'GitHub',
  sourcegraph: 'Sourcegraph',
  moonshot: 'Kimi / Moonshot',
  alibaba: 'Alibaba',
  droid: 'Droid',
  opencode: 'OpenCode',
  trae: 'Trae',
  zhipu: 'Zhipu AI',
};

export function providerLabel(id: string): string {
  return PROVIDER_LABELS[id] ?? id;
}

export const TOKEN_CONFIG = Object.fromEntries(
  TOKEN_SERIES.map((s) => [s.key, { label: s.label, color: s.color }]),
) satisfies ChartConfig;

export const TOKEN_CONFIG_DARK = Object.fromEntries(
  TOKEN_SERIES.map((s) => [s.key, { label: s.label, color: s.darkColor }]),
) satisfies ChartConfig;

export function getChartColors(isDark: boolean) {
  return isDark ? CHART_COLORS_DARK : CHART_COLORS;
}

export function getTokenConfig(isDark: boolean) {
  return isDark ? TOKEN_CONFIG_DARK : TOKEN_CONFIG;
}

export function getTokenColor(s: typeof TOKEN_SERIES[number], isDark: boolean) {
  return isDark ? s.darkColor : s.color;
}

export function formatProductLabel(raw: string): string {
  const labels: Record<string, string> = {
    trae: 'Trae (All)',
    'trae-cn': 'Trae CN',
    'trae-intl': 'Trae International',
  };
  if (labels[raw]) return labels[raw];
  return raw
    .split('-')
    .map((w) => (w === 'cli' ? 'CLI' : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}
