import * as React from 'react';
import { Tooltip, type TooltipProps } from 'recharts';
import { cn } from '../../lib/utils';

export type ChartConfig = Record<
  string,
  {
    label?: React.ReactNode;
    color?: string;
  }
>;

const ChartContext = React.createContext<{ config: ChartConfig } | null>(null);

function useChart(): { config: ChartConfig } {
  const context = React.useContext(ChartContext);
  if (!context) {
    throw new Error('Chart components must be used inside <ChartContainer />');
  }
  return context;
}

export function ChartContainer({
  config,
  className,
  children,
  style,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  config: ChartConfig;
}): React.JSX.Element {
  const cssVariables = Object.fromEntries(
    Object.entries(config).flatMap(([key, value]) => (value.color ? [[`--color-${key}`, value.color]] : [])),
  ) as React.CSSProperties;

  return (
    <ChartContext.Provider value={{ config }}>
      <div
        className={cn(
          'chart-container w-full [contain:inline-size] tabular-nums text-xs [&_.recharts-cartesian-axis-tick_text]:fill-[var(--fg3)] [&_.recharts-cartesian-grid_horizontal_line]:stroke-[var(--grid)] [&_.recharts-cartesian-grid_vertical_line]:stroke-[var(--grid)] [&_.recharts-curve.recharts-tooltip-cursor]:stroke-[var(--border-strong)] [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-[var(--panel-soft)] [&_.recharts-sector:focus]:outline-none [&_.recharts-surface]:overflow-visible',
          className,
        )}
        style={{ ...cssVariables, ...style }}
        {...props}
      >
        {children}
      </div>
    </ChartContext.Provider>
  );
}

export const ChartTooltip = Tooltip;

interface ChartTooltipContentProps extends React.HTMLAttributes<HTMLDivElement> {
  active?: TooltipProps<number, string>['active'];
  payload?: TooltipProps<number, string>['payload'];
  label?: TooltipProps<number, string>['label'];
  hideLabel?: boolean;
  indicator?: 'dot' | 'line';
  labelFormatter?: (label: string) => React.ReactNode;
  formatter?: (value: number | string, name: string) => React.ReactNode;
  /** 在 series 列表底部追加一行汇总（payload 各项 value 求和后用 totalFormatter 渲染）。 */
  showTotal?: boolean;
  totalLabel?: string;
  totalFormatter?: (value: number) => React.ReactNode;
}

export function ChartTooltipContent({
  active,
  payload,
  label,
  hideLabel = false,
  indicator = 'dot',
  labelFormatter,
  formatter,
  showTotal = false,
  totalLabel = 'Total',
  totalFormatter,
  className,
  ...props
}: ChartTooltipContentProps): React.JSX.Element | null {
  const { config } = useChart();

  if (!active || !payload?.length) return null;

  return (
    <div
      className={cn(
        'min-w-[188px] rounded-[10px] border border-[var(--border)] bg-[var(--panel)] px-3.5 py-3 shadow-[0_12px_30px_rgba(43,61,82,0.12)]',
        className,
      )}
      {...props}
    >
      {!hideLabel && label != null ? (
        <div className="mb-2 text-[11px] font-semibold tracking-[0.02em] text-[var(--fg)]">
          {labelFormatter ? labelFormatter(String(label)) : String(label)}
        </div>
      ) : null}
      <div className="grid gap-2">
        {payload.map((item) => {
          const key = String(item.dataKey ?? item.name ?? 'value');
          const itemConfig = config[key];
          const tone = item.color ?? item.stroke ?? itemConfig?.color ?? 'currentColor';
          const itemLabel = itemConfig?.label ?? item.name ?? key;

          return (
            <div key={`${key}-${item.value}`} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5">
              <span
                className={cn('rounded-full bg-current', indicator === 'line' ? 'h-2 w-6' : 'h-2.5 w-2.5')}
                style={{ color: tone }}
              />
              <span className="truncate text-[11px] text-[var(--fg2)]">{itemLabel}</span>
              <span className="text-[11px] font-semibold text-[var(--fg)] tabular-nums">
                {formatter ? formatter(item.value ?? 0, String(itemLabel)) : String(item.value ?? 0)}
              </span>
            </div>
          );
        })}
        {showTotal ? (() => {
          const sum = payload.reduce((acc, it) => acc + Number(it.value ?? 0), 0);
          return (
            <div className="mt-1 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 border-t border-slate-200/80 pt-2 dark:border-white/10">
              <span className="h-2.5 w-2.5" />
              <span className="truncate text-[11px] font-semibold text-[var(--fg2)]">{totalLabel}</span>
              <span className="text-[11px] font-semibold text-[var(--fg)] tabular-nums">
                {totalFormatter ? totalFormatter(sum) : String(sum)}
              </span>
            </div>
          );
        })() : null}
      </div>
    </div>
  );
}
