import { describe, expect, it } from 'vitest';
import { buildDateWindow, buildWhere, parseFilters } from './overview.js';

describe('overview date windows', () => {
  it('builds inclusive windows that include today exactly once', () => {
    const now = new Date('2026-07-20T10:00:00.000Z');

    expect(buildDateWindow('7d', now)).toEqual({
      minDate: '2026-07-14',
      maxDate: '2026-07-20',
      days: 7,
    });
    expect(buildDateWindow('30d', now)).toEqual({
      minDate: '2026-06-21',
      maxDate: '2026-07-20',
      days: 30,
    });
    expect(buildDateWindow('180d', now)).toEqual({
      minDate: '2026-01-22',
      maxDate: '2026-07-20',
      days: 180,
    });
    expect(buildDateWindow('month', now)).toEqual({
      minDate: '2026-07-01',
      maxDate: '2026-07-20',
      days: 20,
    });
  });

  it('applies both bounds while preserving scalar facet filters', () => {
    const filters = parseFilters(new URL('https://example.com/api/v1/public/overview?range=7d&product=trae'))!;
    const where = buildWhere(filters);

    expect(where.whereClause).toContain('b.usage_date >= ?');
    expect(where.whereClause).toContain('b.usage_date <= ?');
    expect(where.whereClause).toContain('b.product IN (?, ?, ?)');
    expect(where.params).toEqual([
      expect.any(String),
      expect.any(String),
      'trae',
      'trae-cn',
      'trae-intl',
    ]);
  });

  it('parses repeated and comma-separated facets as multi-select values', () => {
    const filters = parseFilters(new URL(
      'https://example.com/api/v1/public/overview?range=30d&product=codex&product=claude-code&model=gpt-5,claude-opus',
    ));

    expect(filters?.product).toEqual(['codex', 'claude-code']);
    expect(filters?.model).toEqual(['gpt-5', 'claude-opus']);
  });
});
