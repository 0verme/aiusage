import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ACTIVITY_HEATMAP_WEEKS,
  calculateActivityStreak,
  calculateLongestActivityStreak,
  type ActivityHeatmapDay,
} from '../utils/activity-heatmap-data';
import type { Locale } from '../i18n';

// ── 常量 ──

const MIN_CELL = 12;
const MAX_CELL = 20;
const DEFAULT_CELL = 14;
const GAP = 4;
const DAYS = 7;
const DAY_LABEL_W = 46;
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const GAMMA = 0.7;
const MONTH_ROW = 24;
const LEGEND_ROW = 36;
// Less(~22px) gap 5格 gap More(~26px)；宽度随格子尺寸同步变化

// ── 颜色配置 ──
// CSS variables auto-switch between light/dark, so a single level array suffices.

const LEVELS = ['var(--cell)', 'var(--hm1)', 'var(--hm2)', 'var(--hm3)', 'var(--hm4)'];
const LABEL_FILL = 'var(--fg3)';

function colorForValue(value: number, max: number): string {
  if (value <= 0 || max <= 0) return LEVELS[0];
  const ratio = (value / max) ** GAMMA;
  const idx = Math.max(1, Math.min(4, Math.ceil(ratio * 4)));
  return LEVELS[idx];
}

// ── 日期工具 ──

function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

// ── 数字格式 ──

function fmtCompact(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ── 监听容器宽度 ──

function useContainerWidth(ref: React.RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    // 立即取一次，再监听变化
    setWidth(Math.floor(ref.current.getBoundingClientRect().width));
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setWidth(Math.floor(w));
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

// ── 主组件 ──

export function ActivityHeatmap({ days, metricLabel = 'tokens', locale = 'en', className = '' }: {
  days: ActivityHeatmapDay[];
  metricLabel?: 'tokens' | 'sessions';
  locale?: Locale;
  className?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hasAutoScrolledRef = useRef(false);
  const containerWidth = useContainerWidth(containerRef);

  // 固定展示近一年 53 周，不随容器宽度增加历史空白。
  const weeks = ACTIVITY_HEATMAP_WEEKS;

  const [tooltip, setTooltip] = useState<{
    x: number; y: number;
    date: string; activityValue: number; cost: number;
  } | null>(null);

  const { grid, monthMarks, maxActivity, activeDays, streak, longestStreak, totalActivity } = useMemo(() => {
    const byDate = new Map<string, ActivityHeatmapDay>();
    for (const d of days) byDate.set(d.usageDate, d);

    // 右侧固定对齐今天所在周的周六
    const today = new Date();
    const dayOfWeek = today.getDay();
    const endDate = addDays(today, 6 - dayOfWeek);
    const startDate = addDays(endDate, -(weeks * DAYS - 1));

    const startStr = toDateStr(startDate);
    const endStr = toDateStr(endDate);
    const visibleDays = days.filter(d => d.usageDate >= startStr && d.usageDate <= endStr);

    const maxActivity = Math.max(0, ...visibleDays.map(d => d.activityValue));
    const totalActivity = visibleDays.reduce((s, d) => s + d.activityValue, 0);
    const activeDays = visibleDays.filter(d => d.activityValue > 0).length;

    const streak = calculateActivityStreak(days, today);
    const longestStreak = calculateLongestActivityStreak(days, startDate, today);

    const grid: Array<Array<{ dateStr: string; data?: ActivityHeatmapDay }>> = [];
    const monthMarks: Array<{ weekIdx: number; label: string }> = [];
    const markedMonthKeys = new Set<string>();
    const markedLabels = new Set<string>();

    for (let w = 0; w < weeks; w++) {
      const col: Array<{ dateStr: string; data?: ActivityHeatmapDay }> = [];
      for (let d = 0; d < DAYS; d++) {
        const date = addDays(startDate, w * DAYS + d);
        const ds = toDateStr(date);
        col.push({ dateStr: ds, data: byDate.get(ds) });
        if (date.getDate() === 1) {
          const monthKey = `${date.getFullYear()}-${date.getMonth()}`;
          const label = MONTH_LABELS[date.getMonth()];
          if (!markedMonthKeys.has(monthKey)) {
            markedMonthKeys.add(monthKey);
            if (!markedLabels.has(label)) {
              monthMarks.push({ weekIdx: w, label });
              markedLabels.add(label);
            }
          }
        }
      }
      grid.push(col);
    }

    return { grid, monthMarks, maxActivity, activeDays, streak, longestStreak, totalActivity };
  }, [days, weeks]);

  // 让格子在热力图主体可用宽度内自然放大；低于最小尺寸时保留横向滚动。
  const responsiveCell = (containerWidth - DAY_LABEL_W - (weeks - 1) * GAP) / weeks;
  const cellSize = containerWidth > 0
    ? Math.min(MAX_CELL, Math.max(MIN_CELL, responsiveCell))
    : DEFAULT_CELL;
  const step = cellSize + GAP;
  const svgInnerW = weeks * step - GAP;
  const svgW = DAY_LABEL_W + svgInnerW;
  const svgH = DAYS * step - GAP;
  const totalH = MONTH_ROW + svgH + LEGEND_ROW;
  const legendW = 22 + 5 * step + GAP + 26;
  const legendX = Math.max(DAY_LABEL_W, svgW - legendW);
  let lastMonthLabelX = -Infinity;
  const monthLabelMarks = monthMarks.map((mark) => {
    const x = Math.max(mark.weekIdx * step, lastMonthLabelX + 32);
    lastMonthLabelX = x;
    return { ...mark, x };
  });
  const dayUnit = locale === 'zh' ? '天' : 'd';
  const currentStreakLabel = locale === 'zh' ? '当前连续天数' : 'Current streak';
  const longestStreakLabel = locale === 'zh' ? '最长连续天数' : 'Longest streak';
  const activeDaysLabel = locale === 'zh' ? '个活跃日' : 'active days';
  const totalLabel = locale === 'zh'
    ? `${metricLabel === 'tokens' ? 'Token' : '会话'}总计`
    : `${metricLabel} total`;
  const tooltipWidth = 140;
  const tooltipHeight = 64;
  const tooltipMaxX = Math.max(4, (rootRef.current?.clientWidth ?? containerWidth) - tooltipWidth - 4);
  const tooltipMaxY = Math.max(4, (rootRef.current?.clientHeight ?? totalH) - tooltipHeight - 4);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || containerWidth <= 0) return;
    if (element.scrollWidth <= element.clientWidth) {
      hasAutoScrolledRef.current = false;
      return;
    }
    if (!hasAutoScrolledRef.current) {
      element.scrollLeft = element.scrollWidth;
      hasAutoScrolledRef.current = true;
    }
  }, [containerWidth, svgW]);

  const tooltipLeft = tooltip
    ? Math.min(Math.max(tooltip.x - tooltipWidth / 2, 4), tooltipMaxX)
    : 0;
  const tooltipTop = tooltip
    ? Math.min(Math.max(tooltip.y < 66 ? tooltip.y + cellSize + 8 : tooltip.y - 52, 4), tooltipMaxY)
    : 0;

  return (
    <div ref={rootRef} className={`heatmap-layout relative ${className}`}>
      {/* 连续活跃信息：桌面端置于热力图左侧，窄屏转为两列 */}
      <div
        className="heatmap-streaks grid grid-cols-2 gap-3 border-b pb-4 lg:flex lg:flex-col lg:border-b-0 lg:border-r lg:pb-0"
        style={{ borderColor: 'var(--border)' }}
      >
        <div className="min-w-0 rounded-lg bg-[var(--panel-soft)] px-3 py-3 lg:bg-transparent lg:p-0">
          <div className="font-mono text-[28px] font-bold leading-none tracking-tight" style={{ color: 'var(--fg)' }}>
            {streak} <span className="font-sans text-base font-semibold" style={{ color: 'var(--fg3)' }}>{dayUnit}</span>
          </div>
          <div className="mt-2 font-sans text-xs font-medium" style={{ color: 'var(--fg2)' }}>{currentStreakLabel}</div>
        </div>
        <div className="min-w-0 rounded-lg bg-[var(--panel-soft)] px-3 py-3 lg:bg-transparent lg:p-0">
          <div className="font-mono text-[28px] font-bold leading-none tracking-tight" style={{ color: 'var(--fg)' }}>
            {longestStreak} <span className="font-sans text-base font-semibold" style={{ color: 'var(--fg3)' }}>{dayUnit}</span>
          </div>
          <div className="mt-2 font-sans text-xs font-medium" style={{ color: 'var(--fg2)' }}>{longestStreakLabel}</div>
        </div>
      </div>

      <div className="heatmap-main min-w-0">
        {/* 统计摘要 */}
        <div className="heatmap-summary mb-3 flex flex-wrap items-center gap-5 font-sans text-xs" style={{ color: 'var(--fg2)' }}>
          <span>
            <span className="font-mono font-semibold" style={{ color: 'var(--accent)' }}>{activeDays}</span> {activeDaysLabel}
          </span>
          <span>
            <span className="font-mono font-semibold" style={{ color: 'var(--accent)' }}>{fmtCompact(totalActivity)}</span> {totalLabel}
          </span>
        </div>

        {/* SVG 热力图 */}
        <div ref={containerRef} className="scrollbar-hide relative w-full overflow-x-auto pb-1">
          {containerWidth > 0 && (
            <svg
              width={svgW}
              height={totalH}
              style={{ display: 'block' }}
              aria-label="Activity heatmap"
            >
              {/* 星期标签 */}
              {[1, 3, 5].map((dayIdx) => (
                <text
                  key={dayIdx}
                  x={DAY_LABEL_W - 6}
                  y={MONTH_ROW + dayIdx * step + cellSize / 2}
                  fontSize={11}
                  fill={LABEL_FILL}
                  fontFamily="system-ui, sans-serif"
                  textAnchor="end"
                  dominantBaseline="middle"
                >
                  {dayIdx === 1 ? 'Mon' : dayIdx === 3 ? 'Wed' : 'Fri'}
                </text>
              ))}

              <g transform={`translate(${DAY_LABEL_W}, 0)`}>
                {/* 月份标签 */}
                {monthLabelMarks.map(({ weekIdx, label, x }) => (
                  <text
                    key={label + weekIdx}
                    x={x}
                    y={MONTH_ROW - 4}
                    fontSize={11}
                    fill={LABEL_FILL}
                    fontFamily="system-ui, sans-serif"
                  >
                    {label}
                  </text>
                ))}

                {/* 格子 */}
                <g transform={`translate(0, ${MONTH_ROW})`}>
                  {grid.map((col, wi) =>
                    col.map(({ dateStr, data }, di) => {
                      const activityValue = data?.activityValue ?? 0;
                      const cost = data?.estimatedCostUsd ?? 0;
                      const fill = colorForValue(activityValue, maxActivity);
                      const x = wi * step;
                      const y = di * step;
                      return (
                        <rect
                          key={dateStr}
                          x={x}
                          y={y}
                          width={cellSize}
                          height={cellSize}
                          rx={2}
                          fill={fill}
                          stroke="var(--grid)"
                          strokeWidth={1}
                          style={{ cursor: activityValue > 0 ? 'pointer' : 'default' }}
                          onMouseEnter={() => {
                            const scrollLeft = containerRef.current?.scrollLeft ?? 0;
                            const containerRect = containerRef.current?.getBoundingClientRect();
                            const rootRect = rootRef.current?.getBoundingClientRect();
                            const originX = containerRect && rootRect ? containerRect.left - rootRect.left : 0;
                            const originY = containerRect && rootRect ? containerRect.top - rootRect.top : 0;
                            setTooltip({
                              x: originX + DAY_LABEL_W + x + cellSize / 2 - scrollLeft,
                              y: originY + MONTH_ROW + y,
                              date: dateStr,
                              activityValue,
                              cost,
                            });
                          }}
                          onMouseLeave={() => setTooltip(null)}
                        />
                      );
                    })
                  )}
                </g>
              </g>

              {/* 图例：右下角，不抢热力图主体焦点 */}
              <g transform={`translate(${legendX}, ${totalH - LEGEND_ROW + 10})`}>
                <text x={0} y={10} fontSize={11} fill={LABEL_FILL} fontFamily="system-ui, sans-serif">{locale === 'zh' ? '少' : 'Less'}</text>
                {[0, 1, 2, 3, 4].map((lvl) => (
                  <rect
                    key={lvl}
                    x={24 + lvl * step}
                    y={0}
                    width={cellSize}
                    height={cellSize}
                    rx={2}
                    fill={LEVELS[lvl]}
                    stroke="var(--grid)"
                    strokeWidth={1}
                  />
                ))}
                <text x={24 + 5 * step} y={10} fontSize={11} fill={LABEL_FILL} fontFamily="system-ui, sans-serif">{locale === 'zh' ? '多' : 'More'}</text>
              </g>
            </svg>
          )}
        </div>

        {/* 空状态 */}
        {days.length === 0 && (
          <p className="mt-2 font-sans text-xs" style={{ color: 'var(--fg3)' }}>{locale === 'zh' ? '过去一年暂无活动数据。' : 'No activity data in the past year.'}</p>
        )}
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div
          className="heatmap-tooltip pointer-events-none absolute z-50 rounded-lg border px-2.5 py-1.5 font-mono text-xs shadow-lg"
          style={{
            left: tooltipLeft,
            top: tooltipTop,
            background: 'var(--panel)',
            borderColor: 'var(--border)',
          }}
        >
          <div className="font-semibold" style={{ color: 'var(--fg)' }}>{tooltip.date}</div>
          {tooltip.activityValue > 0 ? (
            <>
              <div style={{ color: 'var(--fg2)' }}>{fmtCompact(tooltip.activityValue)} {metricLabel}</div>
              {metricLabel === 'tokens' && (
                <div style={{ color: 'var(--fg2)' }}>${tooltip.cost.toFixed(4)}</div>
              )}
            </>
          ) : (
            <div style={{ color: 'var(--fg3)' }}>{locale === 'zh' ? '无活动' : 'No activity'}</div>
          )}
        </div>
      )}
    </div>
  );
}
