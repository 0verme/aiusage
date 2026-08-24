import React from 'react';

export class ChartBoundary extends React.Component<
  { children: React.ReactNode; name: string },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode; name: string }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(err: unknown) { console.error(`Chart [${this.props.name}]:`, err); }
  render() {
    if (this.state.hasError) {
      return <EmptyState label={`${this.props.name} failed to render`} />;
    }
    return this.props.children;
  }
}

export function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex min-h-[200px] items-center justify-center text-[13px]" style={{ color: 'var(--fg3)' }}>
      {label}
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg ${className}`} style={{ background: 'var(--cell)' }} />;
}

export function SectionHeader({
  title,
  stat,
  statLabel,
  statTone = 'accent',
}: {
  title: string;
  stat?: string;
  statLabel?: string;
  statTone?: 'accent' | 'green';
}) {
  return (
    <div className="mb-[18px] flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="flex items-center gap-2.5">
        <span className="section-bar" aria-hidden="true" />
        <h2 className="m-0 whitespace-nowrap text-[17px] font-bold" style={{ color: 'var(--fg)' }}>{title}</h2>
      </div>
      {stat && (
        <div className="flex shrink-0 items-baseline gap-2">
          <span
            className="font-mono text-[20px] font-bold tabular-nums"
            style={{ color: statTone === 'green' ? 'var(--green)' : 'var(--accent)' }}
          >
            {stat}
          </span>
          {statLabel && (
            <span className="whitespace-nowrap text-[11px] font-medium" style={{ color: 'var(--fg3)' }}>
              {statLabel}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function ChartLegend({ items }: { items: { label: string; color: string; value?: string }[] }) {
  return (
    <div className="mt-3.5 flex flex-wrap gap-x-[18px] gap-y-2 font-mono text-[12px]">
      {items.map((it) => (
        <div key={it.label} className="flex items-center gap-[7px]">
          <span
            className="h-[9px] w-[9px] shrink-0 rounded-[2px]"
            style={{ backgroundColor: it.color, boxShadow: `0 0 7px ${it.color}` }}
          />
          <span style={{ color: 'var(--fg2)' }}>{it.label}</span>
          {it.value && <span className="font-semibold tabular-nums" style={{ color: 'var(--fg)' }}>{it.value}</span>}
        </div>
      ))}
    </div>
  );
}
