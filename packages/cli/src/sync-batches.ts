import type { IngestDay } from '@aiusage/shared';

const MAX_DAYS_PER_BATCH = 30;
const MAX_ROWS_PER_BATCH = 400;

export function batchIngestDays(days: IngestDay[]): IngestDay[][] {
  const batches: IngestDay[][] = [];
  let batch: IngestDay[] = [];
  let rowCount = 0;

  for (const day of days) {
    const dayRows = day.breakdowns.length + (day.activity?.items.length ?? 0);
    if (batch.length > 0 && (
      batch.length >= MAX_DAYS_PER_BATCH
      || rowCount + dayRows > MAX_ROWS_PER_BATCH
    )) {
      batches.push(batch);
      batch = [];
      rowCount = 0;
    }

    batch.push(day);
    rowCount += dayRows;
  }

  if (batch.length > 0) batches.push(batch);
  return batches;
}
