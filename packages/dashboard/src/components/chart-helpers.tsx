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
  meta,
}: {
  title: string;
  stat?: string;
  statLabel?: string;
  statTone?: 'accent' | 'green';
  meta?: React.ReactNode;
}) {
  return (
    <div className="section-header">
      <div className="section-heading">
        <span className="section-bar" aria-hidden="true" />
        <h2>{title}</h2>
      </div>
      {meta}
      {stat && (
        <div className="section-stat">
          <span className={`section-stat-value${statTone === 'green' ? ' is-green' : ''}`}>
            {stat}
          </span>
          {statLabel && <span className="section-stat-label">{statLabel}</span>}
        </div>
      )}
    </div>
  );
}

export function ChartLegend({ items }: { items: { label: string; color: string; value?: string }[] }) {
  return (
    <div className="chart-legend">
      {items.map((it) => (
        <div key={it.label} className="chart-legend-item">
          <span className="chart-legend-swatch" style={{ backgroundColor: it.color }} />
          <span>{it.label}</span>
          {it.value && <span className="chart-legend-value">{it.value}</span>}
        </div>
      ))}
    </div>
  );
}
