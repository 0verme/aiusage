import type { Locale } from '../i18n';
import type { FacetOption } from '../hooks/use-overview';

export function toggleMultiSelectValue(values: readonly string[], nextValue: string): string[] {
  return values.includes(nextValue)
    ? values.filter((value) => value !== nextValue)
    : [...values, nextValue];
}

export function getMultiSelectSummary(
  value: readonly string[],
  options: readonly FacetOption[],
  allLabel: string,
  locale: Locale,
  formatLabel: (label: string, value: string) => string = (label) => label,
): string {
  if (value.length === 0) return allLabel;
  if (value.length > 1) return locale === 'zh' ? `${value.length} 项` : `${value.length} selected`;

  const selectedValue = value[0];
  const selectedOption = options.find((option) => option.value === selectedValue);
  return formatLabel(selectedOption?.label ?? selectedValue, selectedValue);
}
