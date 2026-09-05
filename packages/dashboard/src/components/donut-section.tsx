import { useState, useRef } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";
import { ChartContainer } from "./ui/chart";
import { arrSum, formatUsd } from "../utils/format";
import { getSharePercent, prepareShareItems } from "../utils/share-data";
import { EmptyState } from "./chart-helpers";
import type { CurrencyMode } from "../hooks/use-cny-rate";

export function ProviderBars({
    data,
    currency = 'auto',
}: {
    data: Array<{ label: string; estimatedCostUsd: number }>;
    currency?: CurrencyMode;
}) {
    if (!data.length) return <EmptyState label="No data" />;
    const max = Math.max(...data.map((d) => d.estimatedCostUsd), 1);
    return (
        <div>
            <h3 className="mb-4 text-[13px] font-semibold text-slate-900 dark:text-slate-300">Provider Share</h3>
            <div className="flex flex-col gap-3">
                {data.map((item) => {
                    const pct = (item.estimatedCostUsd / max) * 100;
                    return (
                        <div key={item.label}>
                            <div className="mb-1 flex items-baseline justify-between text-[12px]">
                                <span className="font-medium text-slate-700 dark:text-slate-300">{item.label}</span>
                                <span className="tabular-nums font-medium text-slate-900 dark:text-slate-300">{formatUsd(item.estimatedCostUsd, currency)}</span>
                            </div>
                            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-[#1a1a1a]">
                                <div className="h-full rounded-full bg-slate-800 dark:bg-slate-300 transition-all duration-500" style={{ width: `${pct}%` }} />
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

export function DonutSection({
    title,
    data,
    colors,
    centerLabel,
    formatValue,
    formatTooltipValue,
}: {
    title: string;
    data: Array<{ label: string; value: string; amount: number }>;
    colors: string[];
    centerLabel: string;
    formatValue: (value: number) => string;
    formatTooltipValue?: (value: number) => string;
}) {
    const folded = prepareShareItems(data, 6);
    const total = arrSum(folded.map((d) => d.amount));

    const containerRef = useRef<HTMLDivElement>(null);
    const [tip, setTip] = useState<{ x: number; y: number; label: string; value: number } | null>(null);

    if (!folded.length) return <EmptyState label="No data" />;

    return (
        <div className="share-section">
            <div className="share-section-header">
                <span className="section-bar" aria-hidden="true" />
                <h3>{title}</h3>
            </div>
            <div className="share-section-body">
                {/* Ring */}
                <div
                    ref={containerRef}
                    className="share-ring"
                    onMouseMove={(e) => {
                        if (!containerRef.current || !tip) return;
                        const rect = containerRef.current.getBoundingClientRect();
                        setTip((prev) => prev && { ...prev, x: e.clientX - rect.left + 12, y: e.clientY - rect.top - 40 });
                    }}
                    onMouseLeave={() => setTip(null)}
                >
                    <ChartContainer config={{}} className="chart-container aspect-square w-full">
                        <ResponsiveContainer width="100%" height="100%">
                            <PieChart>
                                <Pie
                                    data={folded}
                                    dataKey="amount"
                                    nameKey="label"
                                    innerRadius="62%"
                                    outerRadius="86%"
                                    paddingAngle={2}
                                    stroke="none"
                                    onMouseEnter={(_, idx) => {
                                        const item = folded[idx];
                                        if (item) setTip({ x: 0, y: 0, label: item.label, value: item.amount });
                                    }}
                                    onMouseLeave={() => setTip(null)}
                                >
                                    {folded.map((_, i) => (
                                        <Cell key={i} fill={colors[i % colors.length]} />
                                    ))}
                                </Pie>
                            </PieChart>
                        </ResponsiveContainer>
                    </ChartContainer>
                    <div className="share-ring-center">{centerLabel}</div>

                    {/* Tooltip 跟随鼠标 */}
                    {tip && (
                        <div
                            className="share-tooltip pointer-events-none absolute z-10 whitespace-nowrap rounded-lg border px-3.5 py-3 font-mono shadow-lg"
                            style={{ left: tip.x, top: tip.y, background: 'var(--panel)', borderColor: 'var(--border)' }}
                        >
                            <div className="text-[11px]" style={{ color: 'var(--fg2)' }}>{tip.label}</div>
                            <div className="mt-1 text-[11px] font-semibold tabular-nums" style={{ color: 'var(--fg)' }}>{(formatTooltipValue ?? formatValue)(tip.value)}</div>
                        </div>
                    )}
                </div>

                {/* Legend */}
                <div className="share-section-list">
                    {folded.map((item, i) => {
                        const pct = getSharePercent(item.amount, total);
                        const c = colors[i % colors.length];
                        return (
                            <div key={item.value} className="share-section-item">
                                <span className="share-section-name">
                                    <span className="share-section-swatch" style={{ backgroundColor: c }} />
                                    <span>{item.label}</span>
                                </span>
                                <span className="share-section-percent">{pct.toFixed(1)}%</span>
                                <span className="share-section-value">{formatValue(item.amount)}</span>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
