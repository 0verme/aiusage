import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CartesianGrid, Line, LineChart, ReferenceDot, ResponsiveContainer, XAxis, YAxis,
} from 'recharts';
import { ChartContainer, ChartTooltip, type ChartConfig } from './ui/chart';
import type { Locale } from '../i18n';
import { getPalette } from '../palette';
import { formatCompact, formatTokens, shortDate, longDate } from '../utils/format';
import { EmptyState } from './chart-helpers';
import { useIsDark } from '../hooks/use-dark';
import type { CumulativeTokenPoint, FastestGrowthWindow } from '../utils/cumulative-token';

/** 累计 Token：单个总计曲线，用斜率变化表达不同时期的使用强度。 */
export function CumulativeTokenChart({
  points,
  fastestGrowth,
  locale,
}: {
  points: CumulativeTokenPoint[];
  fastestGrowth: FastestGrowthWindow | null;
  locale: Locale;
}) {
  const isDark = useIsDark();
  /** 图表容器横向溢出（移动端/窄屏）时，把 tooltip 固定在可见区域内，避免被视口裁切。 */
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      setOverflowing(el.scrollWidth > el.clientWidth + 1);
      setScrollLeft(el.scrollLeft);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [points.length]);

  /**
   * 增长最快区间落在展示区间内时，才在曲线上点一个小圆点；
   * 区间被展示窗口裁到一半时，落到可见区间的最后一天。
   */
  const marker = useMemo(() => {
    if (!fastestGrowth || points.length === 0) return null;
    const first = points[0];
    const last = points[points.length - 1];
    if (fastestGrowth.endDate < first.usageDate || fastestGrowth.startDate > last.usageDate) return null;
    return points.find((point) => point.usageDate === fastestGrowth.endDate) ?? last;
  }, [fastestGrowth, points]);

  if (points.length === 0) return <EmptyState label="No data" />;

  const accent = getPalette(isDark).accent;
  const config = {
    cumulativeTokens: {
      label: locale === 'zh' ? '累计 Token' : 'Cumulative Tokens',
      color: accent,
    },
  } satisfies ChartConfig;

  return (
    <>
      <div
        className="chart-scroll"
        ref={scrollRef}
        onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)}
      >
        <ChartContainer config={config} className="chart-container trend-chart-container w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points} margin={{ top: 18, left: 4, right: 14, bottom: 0 }}>
              <CartesianGrid vertical={false} className="stroke-slate-100 dark:stroke-white/[0.06]" />
              <XAxis
                dataKey="usageDate" tickLine={false} axisLine={false}
                tickMargin={12} tickFormatter={shortDate} minTickGap={36}
                className="fill-slate-400 dark:fill-slate-500" fontSize={11}
              />
              <YAxis
                tickLine={false} axisLine={false} width={52} tickMargin={8}
                // 累计值起点不为 0，纵轴跟随数据区间，斜率变化才看得见
                domain={['auto', 'auto']}
                tickFormatter={(value) => formatCompact(Number(value), locale)}
                className="fill-slate-400 dark:fill-slate-500" fontSize={11}
              />
              <ChartTooltip
                cursor={{ stroke: isDark ? '#334155' : '#e2e8f0' }}
                position={overflowing ? { x: scrollLeft + 12, y: 12 } : undefined}
                content={
                  <CumulativeTokenTooltip
                    locale={locale}
                    accent={accent}
                    fastestGrowth={fastestGrowth}
                  />
                }
              />
              <Line
                dataKey="cumulativeTokens"
                type="linear"
                stroke={accent}
                strokeWidth={1.8}
                dot={false}
                activeDot={{ r: 3.5, fill: accent, stroke: isDark ? '#151d28' : '#ffffff', strokeWidth: 1.5 }}
                isAnimationActive={false}
              />
              {marker && (
                <ReferenceDot
                  x={marker.usageDate}
                  y={marker.cumulativeTokens}
                  r={3}
                  fill={accent}
                  stroke={isDark ? '#151d28' : '#ffffff'}
                  strokeWidth={1.5}
                  ifOverflow="discard"
                  isFront
                />
              )}
            </LineChart>
          </ResponsiveContainer>
        </ChartContainer>
      </div>

      {fastestGrowth && (
        <div className="cumulative-growth-note">
          <span className="cumulative-growth-note-label">
            {locale === 'zh' ? '增长最快' : 'Fastest growth'}
          </span>
          <span className="cumulative-growth-note-value">
            {fastestGrowth.startDate} ～ {fastestGrowth.endDate}
          </span>
          <span>
            {locale === 'zh' ? `${fastestGrowth.dayCount} 日新增` : `${fastestGrowth.dayCount}-day added`}
            <b>{formatCompact(fastestGrowth.addedTokens, locale)}</b>
          </span>
          <span>
            {locale === 'zh' ? '日均' : 'Daily avg'}
            <b>{formatCompact(fastestGrowth.dailyAverageTokens, locale)}</b>
          </span>
        </div>
      )}
    </>
  );
}

interface CumulativeTooltipProps {
  active?: boolean;
  payload?: { payload?: CumulativeTokenPoint }[];
  locale: Locale;
  accent: string;
  fastestGrowth: FastestGrowthWindow | null;
}

/** 日期 / 当日 Token / 累计 Token；落在增长最快区间内时追加一行轻提示。 */
function CumulativeTokenTooltip({
  active, payload, locale, accent, fastestGrowth,
}: CumulativeTooltipProps) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;

  const inFastestGrowth = fastestGrowth != null
    && point.usageDate >= fastestGrowth.startDate
    && point.usageDate <= fastestGrowth.endDate;

  return (
    <div className="cumulative-tooltip">
      <div className="cumulative-tooltip-date">{longDate(point.usageDate)}</div>
      <div className="cumulative-tooltip-rows">
        <div className="cumulative-tooltip-row">
          <span className="cumulative-tooltip-dot" style={{ backgroundColor: 'var(--fg3)' }} />
          <span className="cumulative-tooltip-label">
            {locale === 'zh' ? '当日 Token' : 'Daily Tokens'}
          </span>
          <span className="cumulative-tooltip-value">{formatTokens(point.totalTokens, locale)}</span>
        </div>
        <div className="cumulative-tooltip-row">
          <span className="cumulative-tooltip-dot" style={{ backgroundColor: accent }} />
          <span className="cumulative-tooltip-label">
            {locale === 'zh' ? '累计 Token' : 'Cumulative Tokens'}
          </span>
          <span className="cumulative-tooltip-value">{formatTokens(point.cumulativeTokens, locale)}</span>
        </div>
      </div>
      {inFastestGrowth && fastestGrowth && (
        <div className="cumulative-tooltip-note">
          {locale === 'zh' ? '增长最快区间' : 'Fastest growth window'}
          {' · '}
          {locale === 'zh' ? `${fastestGrowth.dayCount} 日新增` : `${fastestGrowth.dayCount}-day added`}
          {formatCompact(fastestGrowth.addedTokens, locale)}
        </div>
      )}
    </div>
  );
}
