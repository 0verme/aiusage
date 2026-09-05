import { useState } from 'react';
import { Activity, ArrowRightLeft } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toggleCurrency, useCurrencyStore } from '../hooks/use-cny-rate';

type KpiCardProps = {
  label: string;
  value: string;
  sub?: string;
  suffix?: string;
  highlight?: boolean;
  delta?: string;
  icon?: LucideIcon;
  help?: boolean;
};

function Delta({ value, cost = false }: { value?: string; cost?: boolean }) {
  if (!value) return null;
  const isDown = value.trim().startsWith('-');
  const tone = cost ? (isDown ? 'kpi-delta-good' : 'kpi-delta-bad') : isDown ? 'kpi-delta-down' : 'kpi-delta-up';
  return (
    <span className={`kpi-delta ${tone}`}>
      <span aria-hidden="true">{isDown ? '↓' : '↑'}</span>
      {value}
    </span>
  );
}

function KpiLabel({ label, icon: Icon = Activity, highlight, help }: Pick<KpiCardProps, 'label' | 'icon' | 'highlight' | 'help'>) {
  return (
    <div className="kpi-label">
      <span className={`kpi-icon${highlight ? ' kpi-icon-cost' : ''}`} aria-hidden="true">
        <Icon className="h-4 w-4" strokeWidth={1.9} />
      </span>
      <span className="kpi-label-text">{label}</span>
      {help && <span className="kpi-help" title={label} aria-label={`${label} info`}>?</span>}
    </div>
  );
}

export function KpiCard({
  label,
  value,
  sub,
  suffix,
  highlight = false,
  delta,
  icon,
  help = false,
}: KpiCardProps) {
  return (
    <div className="kpi-content">
      <div className="kpi-header">
        <KpiLabel label={label} icon={icon} highlight={highlight} help={help} />
        <Delta value={delta} />
      </div>
      <div className={`kpi-value${highlight ? ' kpi-value-cost' : ''}`}>
        {value}
        {suffix && <span className="kpi-value-suffix">{suffix}</span>}
      </div>
      <div className="kpi-sub">
        <span>{sub}</span>
      </div>
    </div>
  );
}

export function CostKpiCard({
  label,
  value,
  sub,
  delta,
  icon,
  help = false,
}: {
  label: string;
  value: string;
  sub?: string;
  delta?: string;
  icon?: LucideIcon;
  help?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const { showCny, rate } = useCurrencyStore();

  return (
    <div
      className="kpi-content"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="kpi-header">
        <KpiLabel label={label} icon={icon} highlight help={help} />
        <Delta value={delta} cost />
      </div>
      <div className="kpi-value kpi-value-cost">
        <span>{value}</span>
        {rate && (
          <button
            onClick={toggleCurrency}
            className={`kpi-currency-toggle ${hovered ? 'is-visible' : ''}`}
            title={showCny ? 'Switch to USD' : 'Switch to CNY'}
            aria-label={showCny ? 'Switch to USD' : 'Switch to CNY'}
          >
            <ArrowRightLeft size={13} />
          </button>
        )}
      </div>
      <div className="kpi-sub">
        <span>{sub}</span>
      </div>
    </div>
  );
}
