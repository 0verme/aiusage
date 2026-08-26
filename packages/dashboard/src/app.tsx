import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { RotateCw, Globe, Sun, Moon, Monitor } from 'lucide-react';
import type { Locale, T } from './i18n';
import { I18N, getStoredLocale } from './i18n';
import type { ThemeMode } from './theme';
import { getStoredTheme, applyTheme } from './theme';
import { TOKEN_SERIES, getChartColors, getTokenColor, providerLabel, formatProductLabel } from './constants';
import { useIsDark } from './hooks/use-dark';
import {
  formatUsd, formatUsdFull, formatCompact, formatNumber, formatPercent, formatTokens,
  formatModelName, arrSum,
} from './utils/format';
import type { FiltersState } from './hooks/use-overview';
import { useOverview } from './hooks/use-overview';
import {
  MultiSelectFilter,
  deviceIcon,
  modelIcon,
  productIcon,
} from './components/filters/multi-select-filter';
import { ChartBoundary, EmptyState, Skeleton, SectionHeader, ChartLegend } from './components/chart-helpers';
import { KpiCard, CostKpiCard } from './components/kpi-card';
import { useFetchCnyRate, useCurrencyStore } from './hooks/use-cny-rate';
import { CostTrendChart } from './components/cost-trend-chart';
import { TokenTrendChart } from './components/token-trend-chart';
import { TokenCompositionChart } from './components/token-composition-chart';
import { FlowChart } from './components/flow-chart';
import { DonutSection } from './components/donut-section';
import { ActivityHeatmap } from './components/activity-heatmap';
import { buildActivityHeatmapData } from './utils/activity-heatmap-data';
import { HeaderLogo, FooterLogo, useFaviconFromLogo } from './components/site-logo';
import { SITE_TITLE } from './site-config';
import type { InteractionMetricItem, InteractionMetricsPayload } from '@aiusage/shared';

// ────────────────────────────────────────
// Constants
// ────────────────────────────────────────

function getRanges(t: T) {
  return [
    { value: 'all', label: t.all },
    { value: '7d', label: t.range7d },
    { value: '30d', label: t.range30d },
    { value: '90d', label: t.range90d },
    { value: '180d', label: t.range180d },
    { value: 'month', label: t.thisMonth },
  ] as const;
}

function formatComparisonDelta(current: number, previous: number): string | undefined {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return undefined;
  const delta = ((current - previous) / previous) * 100;
  if (!Number.isFinite(delta)) return undefined;
  const normalized = Math.abs(delta) < 0.05 ? 0 : delta;
  return `${normalized > 0 ? '+' : ''}${normalized.toFixed(1)}%`;
}

// ────────────────────────────────────────
// Theme & Language Toggles
// ────────────────────────────────────────

const THEME_OPTIONS: { value: ThemeMode; icon: typeof Sun }[] = [
  { value: 'system', icon: Monitor },
  { value: 'light', icon: Sun },
  { value: 'dark', icon: Moon },
];

const THEME_LABELS: Record<ThemeMode, { en: string; zh: string }> = {
  system: { en: 'System', zh: '系统' },
  light: { en: 'Light', zh: '日间' },
  dark: { en: 'Dark', zh: '夜间' },
};

function ThemeToggle({ value, onChange, locale }: { value: ThemeMode; onChange: (v: ThemeMode) => void; locale: Locale }) {
  return (
    <div className="pill-group">
      {THEME_OPTIONS.map((o) => {
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className={`pill inline-flex items-center gap-1 px-2.5 py-1.5 text-[12px] ${value === o.value ? 'pill-active' : ''}`}
            aria-label={o.value}
          >
            <Icon className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{THEME_LABELS[o.value][locale]}</span>
          </button>
        );
      })}
    </div>
  );
}

function LangToggle({ value, onChange }: { value: Locale; onChange: (v: Locale) => void }) {
  return (
    <div className="pill-group">
      {(['en', 'zh'] as const).map((l) => (
        <button
          key={l}
          onClick={() => onChange(l)}
          className={`pill px-3 py-1.5 text-[12px] ${value === l ? 'pill-active' : ''}`}
        >
          {l === 'en' ? 'EN' : '中'}
        </button>
      ))}
    </div>
  );
}

// ────────────────────────────────────────
// Controls
// ────────────────────────────────────────

function SegmentedControl({
  value,
  options,
  onChange,
}: {
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="pill-group" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`pill px-3.5 py-1.5 text-[13px] ${value === o.value ? 'pill-active' : ''}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

type InteractionListTone = 'tool' | 'skill' | 'subagent';

function InteractionMetricTile({
  label,
  value,
  suffix,
}: {
  label: string;
  value: string;
  suffix?: string;
}) {
  return (
    <div className="min-w-0 border-b border-[var(--border)] pb-4 last:border-b-0 sm:border-b-0 sm:pb-0">
      <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--fg2)]">
        {label}
      </div>
      <div className="mt-2 whitespace-nowrap font-mono text-[24px] font-bold leading-none tracking-tight tabular-nums text-[var(--fg)] sm:text-[27px]">
        {value}
        {suffix && <span className="text-[14px] font-medium tracking-normal text-[var(--fg3)]">{suffix}</span>}
      </div>
    </div>
  );
}

function InteractionTopList({
  title,
  items,
  locale,
  proxyLabel,
  tone,
}: {
  title: string;
  items: InteractionMetricItem[];
  locale: Locale;
  proxyLabel: string;
  tone: InteractionListTone;
}) {
  if (!items.length) return null;
  const max = Math.max(...items.map((item) => item.eventCount), 1);
  return (
    <div className={`min-w-0 interaction-tone-${tone}`}>
      <h3 className="interaction-list-title mb-3 text-[13px] font-semibold text-[var(--fg)]">{title}</h3>
      <div className="grid gap-3">
        {items.slice(0, 6).map((item) => {
          const proxy = item.proxyCount ?? 0;
          const exact = Math.max(0, item.eventCount - proxy);
          const value = proxy > 0 && exact > 0
            ? `${formatCompact(exact, locale)} / ${formatCompact(proxy, locale)} ${proxyLabel}`
            : proxy > 0
            ? `${formatCompact(proxy, locale)} ${proxyLabel}`
            : formatCompact(item.eventCount, locale);
          return (
            <div key={item.value} className="interaction-list-row min-w-0 rounded-lg px-1.5 py-1">
              <div className="mb-1.5 flex items-baseline justify-between gap-3 text-[12px]">
                <span className="interaction-list-label truncate font-medium text-[var(--fg2)]">{item.label}</span>
                <span className="interaction-list-value shrink-0 font-mono text-[12px] font-semibold tabular-nums">{value}</span>
              </div>
              <div
                className="interaction-progress-track h-1 overflow-hidden rounded-full"
                role="progressbar"
                aria-label={item.label}
                aria-valuemin={0}
                aria-valuemax={max}
                aria-valuenow={item.eventCount}
                aria-valuetext={value}
              >
                <div
                  className="interaction-progress-fill h-full rounded-full"
                  style={{ width: `${Math.max(4, (item.eventCount / max) * 100)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function InteractionMetricsSection({
  metrics,
  t,
  locale,
  animationDelay = '150ms',
}: {
  metrics: InteractionMetricsPayload;
  t: T;
  locale: Locale;
  animationDelay?: string;
}) {
  return (
    <div className="card fade-up p-6" style={{ animationDelay }}>
      <SectionHeader
        title={t.interactionMetrics}
        stat={formatCompact(metrics.exactCount, locale)}
        statLabel={t.exactEvents}
      />
      <div className="mt-6 grid gap-x-6 gap-y-5 sm:grid-cols-4">
        <InteractionMetricTile label={t.functionCalls} value={formatCompact(metrics.functionCallCount, locale)} />
        <InteractionMetricTile label={t.toolCalls} value={formatCompact(metrics.toolCallCount, locale)} />
        <InteractionMetricTile
          label={t.skillCalls}
          value={formatCompact(metrics.skillCallCount, locale)}
          suffix={metrics.skillProxyCount > 0 ? ` / ${formatCompact(metrics.skillProxyCount, locale)}` : undefined}
        />
        <InteractionMetricTile label={t.subagents} value={formatCompact(metrics.subagentCount, locale)} />
      </div>
      <div className="mt-7 grid gap-7 lg:grid-cols-3 lg:gap-8">
        <InteractionTopList title={t.topTools} items={metrics.topTools} locale={locale} proxyLabel={t.proxy} tone="tool" />
        <InteractionTopList title={t.topSkills} items={metrics.topSkills} locale={locale} proxyLabel={t.proxy} tone="skill" />
        <InteractionTopList title={t.topSubagents} items={metrics.topAgents} locale={locale} proxyLabel={t.proxy} tone="subagent" />
      </div>
    </div>
  );
}

// ────────────────────────────────────────
// App
// ────────────────────────────────────────

export function App() {
  const [filters, setFilters] = useState<FiltersState>({
    range: '30d', deviceIds: [], products: [], models: [],
  });

  const {
    overview,
    health,
    kpis,
    metricAvailability,
    fOpts,
    loading,
    error,
    isDemo,
    refresh,
  } = useOverview(filters);
  useFetchCnyRate();
  useCurrencyStore(); // subscribe to re-render on toggle
  useFaviconFromLogo();
  const isDark = useIsDark();
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 640);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 639px)');
    const h = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);


  // Theme
  const [theme, setThemeState] = useState<ThemeMode>(getStoredTheme);
  const isFirstRender = useRef(true);
  const setTheme = useCallback((m: ThemeMode) => { setThemeState(m); applyTheme(m); }, []);
  useEffect(() => {
    applyTheme(theme, !isFirstRender.current);
    isFirstRender.current = false;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => { if (theme === 'system') applyTheme('system'); };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  // Locale
  const [locale, setLocaleState] = useState<Locale>(getStoredLocale);
  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try { localStorage.setItem('aiusage-locale', l); } catch { /* localStorage is optional */ }
  }, []);
  const t: T = I18N[locale];
  const rangeSub = getRanges(t).find((r) => r.value === filters.range)?.label;
  // Sync document title
  useEffect(() => {
    document.title = SITE_TITLE;
  }, []);

  // Token legend (locale-aware)
  const tokenLegendLabels: Record<string, keyof T> = {
    inputTokens: 'input', cachedInputTokens: 'cached',
    cacheWriteTokens: 'cacheWrite', outputTokens: 'output',
    reasoningOutputTokens: 'reasoning',
  };
  const tokenLegend = useMemo(() => {
    if (!overview) return [];
    const tc = overview.tokenComposition;
    return TOKEN_SERIES.map((s) => ({
      key: s.key,
      label: t[tokenLegendLabels[s.key] ?? 'input'],
      color: getTokenColor(s, isDark),
      value: formatCompact(arrSum(tc.map((d) => Number(d[s.key] || 0))), locale),
    }));
  }, [overview, t, locale, isDark]);
  const unavailable = metricAvailability.tokenMetricsUnavailable;
  const activityHeatmap = useMemo(() => buildActivityHeatmapData({
    heatmap: overview?.heatmap ?? [],
    dailyTrend: overview?.dailyTrend ?? [],
    tokenMetricsUnavailable: unavailable,
  }), [overview, unavailable]);
  const kpiDeltas = useMemo(() => {
    const previous = overview?.comparison;
    if (!overview || !kpis || !previous) return {};
    const previousOutput = previous.outputTokens + previous.reasoningOutputTokens;
    const previousCostPerSession = previous.totalSessions > 0
      ? previous.totalCostUsd / previous.totalSessions
      : 0;
    return {
      totalCostUsd: formatComparisonDelta(overview.totalCostUsd, previous.totalCostUsd),
      totalTokens: formatComparisonDelta(kpis.totalTokens, previous.totalTokens),
      inputTokens: formatComparisonDelta(kpis.inputTokens, previous.inputTokens),
      outputTokens: formatComparisonDelta(kpis.outputTokens, previousOutput),
      cachedTokens: formatComparisonDelta(kpis.cachedTokens, previous.cachedInputTokens),
      activeDays: formatComparisonDelta(overview.activeDays, previous.activeDays),
      sessions: formatComparisonDelta(overview.totalSessions, previous.totalSessions),
      costPerSession: formatComparisonDelta(kpis.costPerSession, previousCostPerSession),
      averageDailyCostUsd: formatComparisonDelta(overview.averageDailyCostUsd, previous.averageDailyCostUsd),
      cacheHitRate: formatComparisonDelta(kpis.cacheHitRate, previous.cacheHitRate),
    };
  }, [overview, kpis]);

  return (
    <main className="mx-auto w-full max-w-[1340px] px-4 pb-16 sm:px-6 lg:px-8">

      {/* ── Header ── */}
      <header className="fade-up relative z-20 py-6 sm:py-8">
        <div className="flex flex-wrap items-center justify-between gap-y-3">
          <h1 className="m-0">
            <HeaderLogo />
          </h1>
          <div className="flex items-center gap-2 ml-auto">
            <ThemeToggle value={theme} onChange={setTheme} locale={locale} />
            <LangToggle value={locale} onChange={setLocale} />
            <button
              onClick={refresh}
              className="hidden sm:inline-flex h-[34px] w-[34px] items-center justify-center rounded-[10px] border transition-colors"
              style={{ background: 'var(--panel)', borderColor: 'var(--border)', color: 'var(--fg2)' }}
              aria-label="Refresh"
            >
              <RotateCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

      </header>

      {isDemo && (
        <div
          role="status"
          className="mb-4 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
        >
          <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
          {t.demoBanner}
        </div>
      )}

        {/* ── Range + Filters ── */}
        <div className="relative z-30 mt-2 mb-6 flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="min-w-0 overflow-x-auto scrollbar-hide">
            <SegmentedControl
              value={filters.range}
              options={getRanges(t)}
              onChange={(v) => setFilters((f) => ({ ...f, range: v }))}
            />
          </div>
          {overview && (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <MultiSelectFilter
                label={t.tool}
                value={filters.products ?? []}
                options={fOpts.products}
                allLabel={t.all}
                locale={locale}
                formatLabel={(label) => formatProductLabel(label)}
                getIcon={(option) => productIcon(option.value)}
                onChange={(values) => setFilters((f) => ({ ...f, products: values }))}
                tooltips={{ 'claude-code': t.claudeCodeDataNotice }}
              />
              <MultiSelectFilter
                label={t.model}
                value={filters.models ?? []}
                options={fOpts.models}
                allLabel={t.all}
                locale={locale}
                formatLabel={(label) => formatModelName(label, isMobile)}
                getIcon={(option) => modelIcon(option.value, option.label)}
                onChange={(values) => setFilters((f) => ({ ...f, models: values }))}
              />
              <MultiSelectFilter
                label={t.device}
                value={filters.deviceIds ?? []}
                options={fOpts.devices}
                allLabel={t.all}
                locale={locale}
                getIcon={() => deviceIcon()}
                onChange={(values) => setFilters((f) => ({ ...f, deviceIds: values }))}
              />
            </div>
          )}
        </div>

      {/* ── Content ── */}
      {loading && !overview ? (
        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={`sa-${i}`} className="card px-5 py-5">
                <Skeleton className="mb-3 h-2.5 w-14" />
                <Skeleton className="h-6 w-20" />
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={`sb-${i}`} className="card px-5 py-5">
                <Skeleton className="mb-3 h-2.5 w-14" />
                <Skeleton className="h-6 w-20" />
              </div>
            ))}
          </div>
          <div className="card p-6"><Skeleton className="h-[280px]" /></div>
          <div className="card p-6"><Skeleton className="h-[280px]" /></div>
        </div>
      ) : error ? (
        <div className="card flex min-h-[320px] flex-col items-center justify-center p-8">
          <div className="mb-1.5 text-[13px] text-slate-400 dark:text-slate-500">{t.failedToLoad}</div>
          <div className="text-[13px] text-red-500/80">{error}</div>
        </div>
      ) : (
        <div className="grid gap-4">

          {/* ── KPI Row 1 ── */}
          <div
            className="fade-up grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
            style={{ animationDelay: '50ms' }}
          >
            <div className="kpi kpi-cost col-span-2 sm:col-span-1">
              <CostKpiCard
                label={t.estimatedCost}
                value={unavailable ? t.unavailable : formatUsd(overview?.totalCostUsd ?? 0)}
                sub={rangeSub}
                delta={unavailable ? undefined : kpiDeltas.totalCostUsd}
              />
            </div>
            <div className="kpi">
              <KpiCard label={t.totalTokens} value={unavailable ? t.unavailable : formatCompact(kpis?.totalTokens ?? 0, locale)} sub={locale === 'zh' ? '累计消耗' : 'Cumulative'} delta={unavailable ? undefined : kpiDeltas.totalTokens} />
            </div>
            <div className="kpi">
              <KpiCard label={t.inputTokens} value={unavailable ? t.unavailable : formatCompact(kpis?.inputTokens ?? 0, locale)} sub="Prompt" delta={unavailable ? undefined : kpiDeltas.inputTokens} />
            </div>
            <div className="kpi">
              <KpiCard label={t.outputTokens} value={unavailable ? t.unavailable : formatCompact(kpis?.outputTokens ?? 0, locale)} sub="Completion" delta={unavailable ? undefined : kpiDeltas.outputTokens} />
            </div>
            <div className="kpi">
              <KpiCard label={t.cachedTokens} value={unavailable ? t.unavailable : formatCompact(kpis?.cachedTokens ?? 0, locale)} sub="Cached" delta={unavailable ? undefined : kpiDeltas.cachedTokens} />
            </div>
          </div>

          {/* ── KPI Row 2 ── */}
          <div
            className="fade-up grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
            style={{ animationDelay: '100ms' }}
          >
            <div className="kpi col-span-2 sm:col-span-1">
              <KpiCard
                label={t.activeDays}
                value={String(overview?.activeDays ?? 0)}
                suffix={` / ${overview?.totalDays ?? 0}`}
                sub={locale === 'zh' ? '区间内' : 'In range'}
                delta={kpiDeltas.activeDays}
              />
            </div>
            <div className="kpi">
              <KpiCard
                label={t.sessions}
                value={formatNumber((overview?.totalSessions ?? 0) > 0 ? overview!.totalSessions : (overview?.totalEvents ?? 0))}
                suffix={(overview?.totalSessions ?? 0) > 0 && overview!.totalSessions !== overview!.totalEvents ? ` / ${formatNumber(overview!.totalEvents)}` : undefined}
                sub={locale === 'zh' ? '对话 / 消息' : 'Sessions / Msgs'}
                delta={kpiDeltas.sessions}
              />
            </div>
            <div className="kpi">
              <KpiCard label={t.costPerSession} value={unavailable ? t.unavailable : formatUsd(kpis?.costPerSession ?? 0)} sub={locale === 'zh' ? '每会话' : 'Per session'} delta={unavailable ? undefined : kpiDeltas.costPerSession} />
            </div>
            <div className="kpi">
              <KpiCard label={t.avgDailyCost} value={unavailable ? t.unavailable : formatUsd(overview?.averageDailyCostUsd ?? 0)} sub={locale === 'zh' ? '平均' : 'Average'} delta={unavailable ? undefined : kpiDeltas.averageDailyCostUsd} />
            </div>
            <div className="kpi">
              <KpiCard label={t.cacheHitRate} value={unavailable ? t.unavailable : formatPercent(kpis?.cacheHitRate ?? 0)} sub={locale === 'zh' ? '高效复用' : 'Reuse'} delta={unavailable ? undefined : kpiDeltas.cacheHitRate} />
            </div>
          </div>

          {unavailable && (
            <div className="fade-up rounded-xl border border-amber-200/80 bg-amber-50/70 px-4 py-3 text-[13px] text-amber-900 dark:border-amber-950/60 dark:bg-amber-950/20 dark:text-amber-200">
              <span className="font-medium">{t.eventOnlySource}.</span> {t.eventOnlyNotice}
            </div>
          )}

          {/* ── Activity Heatmap ── */}
          <div className="card fade-up p-6" style={{ animationDelay: '120ms' }}>
            <SectionHeader title={locale === 'zh' ? '年度活跃热力图' : 'Activity Heatmap'} />
            <ActivityHeatmap days={activityHeatmap.days} metricLabel={activityHeatmap.metricLabel} locale={locale} />
          </div>

          {overview?.interactionMetrics && (
            <InteractionMetricsSection metrics={overview.interactionMetrics} t={t} locale={locale} animationDelay="150ms" />
          )}

          {/* ── Cost Trend ── */}
          <div className="card fade-up p-6" style={{ animationDelay: '150ms' }}>
            <SectionHeader title={t.costTrend} stat={unavailable ? t.unavailable : formatUsd(overview?.totalCostUsd ?? 0)} statTone="green" />
            {unavailable ? (
              <EmptyState label={t.costUnavailable} />
            ) : (
              <ChartBoundary name="Cost Trend">
                <CostTrendChart
                  data={overview?.dailyTrend ?? []}
                  providerTrend={overview?.providerDailyTrend ?? []}
                />
              </ChartBoundary>
            )}
          </div>

          {/* ── Token Trend ── */}
          <div className="card fade-up p-6" style={{ animationDelay: '230ms' }}>
            <SectionHeader title={t.tokenTrend} stat={unavailable ? t.unavailable : formatCompact(kpis?.totalTokens ?? 0, locale)} />
            {unavailable ? (
              <EmptyState label={t.tokenUnavailable} />
            ) : (
              <ChartBoundary name="Token Trend">
                <TokenTrendChart
                  data={overview?.tokenComposition ?? []}
                  locale={locale}
                  totalLabel={t.total}
                  legendItems={tokenLegend}
                />
              </ChartBoundary>
            )}
          </div>

          {/* ── Token Composition ── */}
          <div className="card fade-up p-6" style={{ animationDelay: '280ms' }}>
            <SectionHeader title={t.tokenComposition} stat={unavailable ? t.unavailable : formatCompact(kpis?.totalTokens ?? 0, locale)} />
            {unavailable ? (
              <EmptyState label={t.tokenUnavailable} />
            ) : (
              <>
                <ChartBoundary name="Token Composition">
                  <TokenCompositionChart data={overview?.tokenComposition ?? []} locale={locale} totalLabel={t.total} />
                </ChartBoundary>
                <ChartLegend items={tokenLegend} />
              </>
            )}
          </div>

          {/* ── Flow & Share ── */}
          <div className="fade-up grid gap-4 lg:grid-cols-5" style={{ animationDelay: '330ms' }}>
            <div className="card p-6 lg:col-span-3">
              <SectionHeader title={t.tokenFlow} />
              {unavailable ? (
                <EmptyState label={t.tokenUnavailable} />
              ) : (
                <ChartBoundary name="Token Flow">
                  <FlowChart data={overview?.sankey} />
                </ChartBoundary>
              )}
            </div>
            <div className="card flex flex-col p-6 lg:col-span-2">
              {unavailable ? (
                <EmptyState label={t.shareUnavailable} />
              ) : (
                <ChartBoundary name="Share">
                  <div className="flex flex-1 flex-col">
                    <DonutSection
                      title={t.providerShare}
                      data={(overview?.filters.options.providers ?? []).map((p) => ({
                        value: p.value,
                        label: providerLabel(p.value),
                        amount: p.estimatedCostUsd,
                      }))}
                      colors={getChartColors(isDark)}
                      centerLabel={formatUsd(overview?.totalCostUsd ?? 0)}
                      formatValue={formatUsd}
                      formatTooltipValue={formatUsdFull}
                    />
                    <div className="my-5 border-t" style={{ borderColor: 'var(--border)' }} />
                    <DonutSection
                      title={t.modelShare}
                      data={(overview?.modelCostShare ?? []).map((m) => ({
                        value: m.value,
                        label: formatModelName(m.label, isMobile),
                        amount: m.totalTokens,
                      }))}
                      colors={getChartColors(isDark)}
                      centerLabel={formatCompact(kpis?.totalTokens ?? 0, locale)}
                      formatValue={(value) => formatCompact(value, locale)}
                      formatTooltipValue={(value) => formatTokens(value, locale)}
                    />
                    <div className="my-5 border-t" style={{ borderColor: 'var(--border)' }} />
                    <DonutSection
                      title={t.deviceShare}
                      data={(overview?.filters.options.devices ?? []).map((d) => ({
                        value: d.value,
                        label: d.label,
                        amount: d.estimatedCostUsd,
                      }))}
                      colors={getChartColors(isDark)}
                      centerLabel={formatUsd(overview?.totalCostUsd ?? 0)}
                      formatValue={formatUsd}
                      formatTooltipValue={formatUsdFull}
                    />
                  </div>
                </ChartBoundary>
              )}
            </div>
          </div>

        </div>
      )}

      {/* ── Footer ── */}
      <footer className="fade-up mt-16 border-t pb-10 pt-8" style={{ borderColor: 'var(--border)' }}>
        <div className="flex flex-col items-center gap-4">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-2 font-display text-[14px] font-semibold" style={{ color: 'var(--fg)' }}>
              <FooterLogo />
              {SITE_TITLE}
            </span>
            {health?.version && (
              <span
                className="font-mono rounded-full px-2 py-0.5 text-[10px] font-medium"
                style={{ background: 'var(--cell)', color: 'var(--fg3)' }}
              >
                v{health.version}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 font-mono text-[12px]" style={{ color: 'var(--fg3)' }}>
            <a href="/pricing" className="transition-colors hover:opacity-80" style={{ color: 'var(--fg2)' }}>
              {t.pricing}
            </a>
            <span style={{ opacity: 0.4 }}>·</span>
            <a href="/embed/docs" className="transition-colors hover:opacity-80" style={{ color: 'var(--fg2)' }}>
              {t.embedWidgets}
            </a>
            <span style={{ opacity: 0.4 }}>·</span>
            <a
              href="https://token.overme.cn"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 transition-colors hover:opacity-80"
              style={{ color: 'var(--accent)' }}
            >
              <Globe className="h-3.5 w-3.5" />
              <span>token.overme.cn</span>
            </a>
            <span style={{ opacity: 0.4 }}>·</span>
            <span style={{ color: 'var(--fg2)' }}>Powered by Overme</span>
          </div>
        </div>
      </footer>
    </main>
  );
}
