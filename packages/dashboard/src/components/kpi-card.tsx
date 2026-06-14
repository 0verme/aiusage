import { useState } from 'react';
import { ArrowRightLeft } from 'lucide-react';
import { toggleCurrency, useCurrencyStore } from '../hooks/use-cny-rate';

export function KpiCard({
  label,
  value,
  sub,
  suffix,
  highlight = false,
}: {
  label: string;
  value: string;
  sub?: string;
  suffix?: string;
  highlight?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 px-[18px] py-[17px]">
      <div className="text-[12px]" style={{ color: highlight ? 'var(--green)' : 'var(--fg2)', letterSpacing: '0.02em' }}>
        {label}
      </div>
      <div
        className="font-mono text-[24px] sm:text-[27px] font-bold leading-none tabular-nums"
        style={{ color: highlight ? 'var(--green)' : 'var(--fg)' }}
      >
        {value}
        {suffix && <span style={{ color: 'var(--fg3)' }}>{suffix}</span>}
      </div>
      {sub && <div className="font-mono text-[11px]" style={{ color: 'var(--fg3)' }}>{sub}</div>}
    </div>
  );
}

export function CostKpiCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  const [hovered, setHovered] = useState(false);
  const { showCny, rate } = useCurrencyStore();

  return (
    <div
      className="flex flex-col gap-2 px-[18px] py-[17px]"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="text-[12px]" style={{ color: 'var(--green)', letterSpacing: '0.02em' }}>
        {label}
      </div>
      <div className="flex items-center gap-1.5">
        <span
          className="font-mono text-[30px] sm:text-[34px] font-bold leading-none tabular-nums"
          style={{ color: 'var(--green)', textShadow: '0 0 18px var(--green-glow)' }}
        >
          {value}
        </span>
        {rate && (
          <button
            onClick={toggleCurrency}
            className={`p-0.5 rounded transition-opacity cursor-pointer ${hovered ? 'opacity-100' : 'opacity-0'}`}
            style={{ color: 'var(--fg3)' }}
            title={showCny ? 'Switch to USD' : 'Switch to CNY'}
          >
            <ArrowRightLeft size={12} />
          </button>
        )}
      </div>
      {sub && <div className="font-mono text-[11px]" style={{ color: 'var(--fg3)' }}>{sub}</div>}
    </div>
  );
}
