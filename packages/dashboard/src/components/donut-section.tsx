import { useState, useRef } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";
import { ChartContainer } from "./ui/chart";
import { formatUsd, formatUsdFull, arrSum, foldItems } from "../utils/format";
import { EmptyState } from "./chart-helpers";

export function ProviderBars({ data }: { data: Array<{ label: string; estimatedCostUsd: number }> }) {
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
                                <span className="tabular-nums font-medium text-slate-900 dark:text-slate-300">{formatUsd(item.estimatedCostUsd)}</span>
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
}: {
    title: string;
    data: Array<{ label: string; value: string; estimatedCostUsd: number; eventCount: number }>;
    colors: string[];
    centerLabel: string;
}) {
    const sorted = [...data].sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd);
    const folded = foldItems(sorted, 6);
    const total = arrSum(folded.map((d) => d.estimatedCostUsd));

    const containerRef = useRef<HTMLDivElement>(null);
    const [tip, setTip] = useState<{ x: number; y: number; label: string; value: number } | null>(null);

    if (!folded.length) return <EmptyState label="No data" />;

    return (
        <div>
            <div className="mb-3.5 flex items-center gap-2.5">
                <span className="section-bar" aria-hidden="true" />
                <h3 className="m-0 text-[16px] font-bold" style={{ color: 'var(--fg)' }}>{title}</h3>
            </div>
            <div className="grid grid-cols-[2fr_3fr] items-center gap-3">
                {/* Ring */}
                <div
                    ref={containerRef}
                    className="relative flex items-center justify-center"
                    onMouseMove={(e) => {
                        if (!containerRef.current || !tip) return;
                        const rect = containerRef.current.getBoundingClientRect();
                        setTip((prev) => prev && { ...prev, x: e.clientX - rect.left + 12, y: e.clientY - rect.top - 40 });
                    }}
                    onMouseLeave={() => setTip(null)}
                >
                    <ChartContainer config={{}} className="aspect-square w-full max-w-[130px]">
                        <ResponsiveContainer width="100%" height="100%">
                            <PieChart>
                                <Pie
                                    data={folded}
                                    dataKey="estimatedCostUsd"
                                    nameKey="label"
                                    innerRadius="62%"
                                    outerRadius="86%"
                                    paddingAngle={2}
                                    stroke="none"
                                    onMouseEnter={(_, idx) => {
                                        const item = folded[idx];
                                        if (item) setTip({ x: 0, y: 0, label: item.label, value: item.estimatedCostUsd });
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
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                        <span className="font-mono text-[14px] font-bold tabular-nums" style={{ color: 'var(--fg)' }}>{centerLabel}</span>
                    </div>

                    {/* Tooltip 跟随鼠标 */}
                    {tip && (
                        <div
                            className="pointer-events-none absolute z-10 whitespace-nowrap rounded-lg border px-3.5 py-3 font-mono shadow-lg"
                            style={{ left: tip.x, top: tip.y, background: 'var(--panel)', borderColor: 'var(--border)' }}
                        >
                            <div className="text-[11px]" style={{ color: 'var(--fg2)' }}>{tip.label}</div>
                            <div className="mt-1 text-[11px] font-semibold tabular-nums" style={{ color: 'var(--fg)' }}>{formatUsdFull(tip.value)}</div>
                        </div>
                    )}
                </div>

                {/* Legend */}
                <div className="grid min-w-0 gap-y-2 font-mono text-[12px]" style={{ gridTemplateColumns: "10px minmax(0,1fr) auto auto", columnGap: "10px" }}>
                    {folded.map((item, i) => {
                        const pct = total > 0 ? (item.estimatedCostUsd / total) * 100 : 0;
                        const c = colors[i % colors.length];
                        return (
                            <div key={item.value} className="col-span-4 grid grid-cols-subgrid items-center">
                                <span className="h-[9px] w-[9px] rounded-[2px]" style={{ backgroundColor: c, boxShadow: `0 0 7px ${c}` }} />
                                <span className="truncate" style={{ color: 'var(--fg)' }}>{item.label}</span>
                                <span className="text-right tabular-nums" style={{ color: 'var(--fg2)' }}>{pct.toFixed(1)}%</span>
                                <span className="text-right font-semibold tabular-nums" style={{ color: 'var(--fg)' }}>{formatUsd(item.estimatedCostUsd)}</span>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
