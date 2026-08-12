import { describe, expect, it } from 'vitest';
import type { IngestActivityItem, IngestDay } from '@aiusage/shared';
import { batchIngestDays } from '../sync-batches.js';

function activityItems(count: number): IngestActivityItem[] {
  return Array.from({ length: count }, (_, index) => ({
    provider: 'openai',
    product: 'codex',
    source: 'openai/codex',
    project: 'test',
    kind: 'function_call',
    name: `tool-${index}`,
    count: 1,
    confidence: 'exact',
  }));
}

describe('batchIngestDays', () => {
  it('limits high-activity uploads by row count', () => {
    const days: IngestDay[] = ['2026-08-01', '2026-08-02', '2026-08-03'].map(usageDate => ({
      usageDate,
      breakdowns: [],
      activity: { items: activityItems(200) },
    }));

    expect(batchIngestDays(days).map(batch => batch.length)).toEqual([2, 1]);
  });

  it('keeps the existing 30-day cap for small payloads', () => {
    const days: IngestDay[] = Array.from({ length: 31 }, (_, index) => ({
      usageDate: `2026-07-${String(index + 1).padStart(2, '0')}`,
      breakdowns: [],
    }));

    expect(batchIngestDays(days).map(batch => batch.length)).toEqual([30, 1]);
  });
});
