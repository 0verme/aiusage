import { useEffect, useId, useRef, useState } from 'react';
import {
  Bot,
  BrainCircuit,
  Check,
  ChevronDown,
  Cloud,
  Code2,
  Cpu,
  Laptop,
  MousePointer2,
  Sparkles,
  Terminal,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { Locale } from '../../i18n';
import type { FacetOption } from '../../hooks/use-overview';
import { formatCompact } from '../../utils/format';
import { getMultiSelectSummary, toggleMultiSelectValue } from '../../utils/multi-select-filter';

export type FilterIcon = LucideIcon;

/** Map known tool names to lightweight icons while keeping unknown tools visible. */
export function productIcon(value: string): FilterIcon {
  const id = value.toLowerCase();
  if (id.includes('codex')) return Code2;
  if (id.includes('claude')) return Bot;
  if (id.includes('gemini')) return Sparkles;
  if (id.includes('grok')) return Sparkles;
  if (id.includes('kimi')) return Cloud;
  if (id.includes('copilot')) return Bot;
  if (id.includes('trae')) return Zap;
  if (id.includes('qwen')) return BrainCircuit;
  if (id.includes('deepseek')) return BrainCircuit;
  if (id.includes('cursor')) return MousePointer2;
  if (id.includes('opencode')) return Terminal;
  if (id.includes('pi')) return BrainCircuit;
  return Bot;
}

/** Map model/provider names to an icon, with a generic AI fallback for new models. */
export function modelIcon(value: string, label: string): FilterIcon {
  const id = `${value} ${label}`.toLowerCase();
  if (id.includes('claude') || id.includes('anthropic')) return Bot;
  if (id.includes('deepseek')) return BrainCircuit;
  if (id.includes('gemini')) return Sparkles;
  if (id.includes('glm') || id.includes('zhipu') || id.includes('智谱')) return BrainCircuit;
  if (id.includes('kimi') || id.includes('moonshot')) return Cloud;
  if (id.includes('qwen') || id.includes('通义')) return BrainCircuit;
  if (id.includes('grok')) return Sparkles;
  if (id.includes('gpt') || /\bo\d/.test(id) || id.includes('openai')) return Cpu;
  if (id.includes('codex')) return Code2;
  if (id.includes('copilot')) return Bot;
  if (id.includes('trae')) return Zap;
  return Bot;
}

function FilterIcon({ icon }: { icon?: FilterIcon }) {
  if (!icon) return null;
  const Icon = icon;
  return <Icon aria-hidden className="h-4 w-4 shrink-0 text-[var(--fg3)]" strokeWidth={1.8} />;
}

export interface MultiSelectFilterProps {
  label: string;
  value: string[];
  options: FacetOption[];
  onChange: (value: string[]) => void;
  allLabel?: string;
  locale: Locale;
  formatLabel?: (label: string, value: string) => string;
  getIcon?: (option: FacetOption) => FilterIcon | undefined;
  tooltips?: Record<string, string>;
}

export function MultiSelectFilter({
  label,
  value,
  options,
  onChange,
  allLabel = 'All',
  locale,
  formatLabel = (text) => text,
  getIcon,
  tooltips,
}: MultiSelectFilterProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listboxId = useId();
  const selected = new Set(value);
  const selectedOptions = options.filter((option) => selected.has(option.value));
  const hasSelection = value.length > 0;
  const summary = getMultiSelectSummary(value, options, allLabel, locale, formatLabel);
  const selectedIcon = hasSelection && value.length === 1
    ? getIcon?.(selectedOptions[0] ?? { value: value[0], label: value[0] })
    : undefined;

  useEffect(() => {
    if (!open) return;

    const closeOnOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  if (!options.length) return null;

  const toggleValue = (nextValue: string) => {
    onChange(toggleMultiSelectValue(value, nextValue));
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        aria-label={`${label}: ${summary}`}
        onClick={() => setOpen((isOpen) => !isOpen)}
        className={`inline-flex h-9 max-w-full items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--glow-strong)] ${
          hasSelection
            ? 'bg-[var(--panel)] text-[var(--fg2)] shadow-sm ring-1 ring-[var(--border)]'
            : 'bg-[var(--panel-soft)] text-[var(--fg3)] hover:text-[var(--fg2)]'
        }`}
      >
        <FilterIcon icon={selectedIcon} />
        <span className="flex min-w-0 items-center gap-1.5 truncate">
          <span className="shrink-0">{label}</span>
          <span className="min-w-0 truncate">{summary}</span>
        </span>
        <ChevronDown
          aria-hidden
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          id={listboxId}
          role="listbox"
          aria-label={label}
          className="absolute right-0 top-full z-50 mt-2 w-[min(340px,calc(100vw-2rem))] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-[0_20px_60px_rgba(15,23,42,0.14)] sm:left-0 sm:right-auto"
        >
          <div className="max-h-80 overflow-y-auto p-1.5">
            <button
              type="button"
              role="option"
              aria-selected={value.length === 0}
              onClick={() => onChange([])}
              className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--glow-strong)] ${
                value.length === 0
                  ? 'bg-[var(--glow)] text-[var(--fg)]'
                  : 'text-[var(--fg2)] hover:bg-[var(--bg2)] hover:text-[var(--fg)]'
              }`}
            >
              <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                value.length === 0
                  ? 'border-[var(--accent)] bg-[var(--accent)] text-[#04121a]'
                  : 'border-[var(--border)] text-[var(--fg3)]'
              }`}>
                {value.length === 0 && <Check aria-hidden className="h-3 w-3" />}
              </span>
              <span className="font-medium">{allLabel}</span>
            </button>

            {options.map((option) => {
              const checked = selected.has(option.value);
              const tip = tooltips?.[option.value];
              const rawModelTip = option.rawModels?.length && option.rawModels.length > 1
                ? `${locale === 'zh' ? '原始模型别名' : 'Raw model aliases'}:\n${option.rawModels.map((rawModel) => `- ${rawModel}`).join('\n')}`
                : undefined;
              const icon = getIcon?.(option);
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={checked}
                  title={tip ?? rawModelTip}
                  onClick={() => toggleValue(option.value)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--glow-strong)] ${
                    checked
                      ? 'bg-[var(--glow)] text-[var(--fg)]'
                      : 'text-[var(--fg2)] hover:bg-[var(--bg2)] hover:text-[var(--fg)]'
                  }`}
                >
                  <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                    checked
                      ? 'border-[var(--accent)] bg-[var(--accent)] text-[#04121a]'
                      : 'border-[var(--border)]'
                  }`}>
                    {checked && <Check aria-hidden className="h-3 w-3" />}
                  </span>
                  {icon && (
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                      <FilterIcon icon={icon} />
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate">{formatLabel(option.label, option.value)}</span>
                  {option.aliasCount !== undefined && option.aliasCount > 1 && (
                    <span className="shrink-0 text-[11px] text-[var(--fg3)]">
                      · {option.aliasCount} {locale === 'zh' ? '个别名' : 'aliases'}
                    </span>
                  )}
                  {option.eventCount !== undefined && (
                    <span className="shrink-0 tabular-nums text-[var(--fg3)]">
                      {formatCompact(option.eventCount, locale)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function deviceIcon(): FilterIcon {
  return Laptop;
}
