/**
 * Compare the date prefix of AIUsage pricing versions.
 *
 * Pricing versions intentionally carry descriptive suffixes rather than using
 * semver. Only a validated YYYY-MM-DD prefix is comparable; arbitrary suffixes
 * on the same day are deliberately treated as unknown instead of compared as
 * ordinary strings.
 */
export function pricingVersionDate(version: string): string | null {
  const date = version.match(/^(\d{4}-\d{2}-\d{2})(?:-|$)/)?.[1];
  if (!date) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date
    ? null
    : date;
}

export function comparePricingVersions(
  left: string,
  right: string,
): -1 | 0 | 1 | null {
  if (left === right) return 0;
  const leftDate = pricingVersionDate(left);
  const rightDate = pricingVersionDate(right);
  if (!leftDate || !rightDate || leftDate === rightDate) return null;
  return leftDate < rightDate ? -1 : 1;
}

export function isPricingVersionOlder(candidate: string, reference: string): boolean {
  return comparePricingVersions(candidate, reference) === -1;
}
