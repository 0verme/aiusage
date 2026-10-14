import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseTs,
  dateKey,
  inferProviderFromModel,
  projectFromPath,
  resolveProjectFields,
  normalizeModelName,
  scannerModelFields,
  mapWithConcurrency,
  dateWindowStartMs,
  filterFilesModifiedSince,
} from '../utils.js';

describe('parseTs', () => {
  it('treats 10-digit numeric values as Unix seconds (not milliseconds)', () => {
    // Kimi wire.jsonl 用秒级时间戳，按毫秒解析会落到 1970-01-21。
    const ts = parseTs(1775196391.26428);
    expect(ts).not.toBeNull();
    expect(ts!.getUTCFullYear()).toBe(2026);
  });

  it('treats 13-digit numeric values as milliseconds', () => {
    const ms = Date.UTC(2026, 0, 15, 12, 0, 0);
    const ts = parseTs(ms);
    expect(ts).not.toBeNull();
    expect(ts!.getTime()).toBe(ms);
  });

  it('parses ISO strings', () => {
    const ts = parseTs('2026-06-01T08:40:27.667Z');
    expect(ts).not.toBeNull();
    expect(ts!.getUTCFullYear()).toBe(2026);
  });

  it('parses numeric strings as seconds when sub-1e12', () => {
    const ts = parseTs('1775196391');
    expect(ts).not.toBeNull();
    expect(ts!.getUTCFullYear()).toBe(2026);
  });

  it('rejects values before the validity floor (2015)', () => {
    expect(parseTs(0)).toBeNull(); // epoch
    expect(parseTs(1)).toBeNull(); // 1 秒，仍是 1970
    expect(parseTs('2010-01-01T00:00:00Z')).toBeNull();
  });

  it('rejects null/empty/invalid', () => {
    expect(parseTs(undefined)).toBeNull();
    expect(parseTs(null as unknown as undefined)).toBeNull();
    expect(parseTs('')).toBeNull();
    expect(parseTs('not-a-date')).toBeNull();
  });
});

describe('dateKey', () => {
  it('formats local date as YYYY-MM-DD', () => {
    const d = new Date(2026, 5, 2); // 本地 6/2
    expect(dateKey(d)).toBe('2026-06-02');
  });
});

describe('mapWithConcurrency', () => {
  it('bounds active workers and preserves input ordering', async () => {
    let activeWorkers = 0;
    let peakWorkers = 0;
    const results = await mapWithConcurrency([0, 1, 2, 3, 4], 2, async (value) => {
      activeWorkers += 1;
      peakWorkers = Math.max(peakWorkers, activeWorkers);
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
      activeWorkers -= 1;
      return value * 2;
    });

    expect(peakWorkers).toBe(2);
    expect(results).toEqual([0, 2, 4, 6, 8]);
  });
});

describe('dateWindowStartMs', () => {
  it('returns local midnight of the earliest requested date', () => {
    expect(dateWindowStartMs(['2026-10-09', '2026-10-07', '2026-10-11']))
      .toBe(new Date(2026, 9, 7).getTime());
  });

  it('returns undefined when no usable date is supplied', () => {
    expect(dateWindowStartMs([])).toBeUndefined();
    expect(dateWindowStartMs(['not-a-date'])).toBeUndefined();
  });
});

describe('filterFilesModifiedSince', () => {
  it('drops files last modified before the window and keeps the rest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiusage-window-'));
    try {
      const stale = join(dir, 'stale.jsonl');
      const recent = join(dir, 'recent.jsonl');
      await writeFile(stale, '{}\n', 'utf-8');
      await writeFile(recent, '{}\n', 'utf-8');
      await utimes(stale, new Date(2026, 9, 1), new Date(2026, 9, 1));
      await utimes(recent, new Date(2026, 9, 10), new Date(2026, 9, 10));

      const kept = await filterFilesModifiedSince([stale, recent], new Date(2026, 9, 9).getTime());
      expect(kept).toEqual([recent]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps every file when no window bound is supplied', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiusage-window-'));
    try {
      const file = join(dir, 'a.jsonl');
      await writeFile(file, '{}\n', 'utf-8');
      await utimes(file, new Date(2020, 0, 1), new Date(2020, 0, 1));
      expect(await filterFilesModifiedSince([file], undefined)).toEqual([file]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('treats the window bound as inclusive', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiusage-window-'));
    try {
      const file = join(dir, 'edge.jsonl');
      await writeFile(file, '{}\n', 'utf-8');
      await utimes(file, new Date(2026, 9, 9), new Date(2026, 9, 9));
      const observedMtimeMs = (await stat(file)).mtimeMs;

      expect(await filterFilesModifiedSince([file], observedMtimeMs)).toEqual([file]);
      expect(await filterFilesModifiedSince([file], observedMtimeMs + 1)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps files whose stat fails so callers still get a chance to read them', async () => {
    const missing = join(tmpdir(), 'aiusage-window-does-not-exist.jsonl');
    expect(await filterFilesModifiedSince([missing], Date.now())).toEqual([missing]);
  });
});

describe('inferProviderFromModel', () => {
  it('识别常见跨工具模型供应商，并保留未知模型的 fallback', () => {
    expect(inferProviderFromModel('claude-sonnet-4-6', 'pi')).toBe('anthropic');
    expect(inferProviderFromModel('gpt-5.6', 'pi')).toBe('openai');
    expect(inferProviderFromModel('gemini-3.1-pro-preview', 'pi')).toBe('google');
    expect(inferProviderFromModel('custom-model', 'pi')).toBe('pi');
  });
});

describe('scanner model identity', () => {
  it('keeps raw model separate from a pricing-compatible date key', () => {
    expect(scannerModelFields(
      'claude-opus-4-5-20251101',
      normalizeModelName('claude-opus-4-5-20251101'),
    )).toEqual({
      model: 'claude-opus-4-5',
      rawModel: 'claude-opus-4-5-20251101',
      pricingModelKey: 'claude-opus-4-5',
    });
  });

  it('does not add duplicate fields when the source model is already the pricing key', () => {
    expect(scannerModelFields('gpt-5.6')).toEqual({ model: 'gpt-5.6' });
  });
});

describe('project path parsing', () => {
  it('兼容 Windows 与 POSIX 路径分隔符', () => {
    expect(projectFromPath('C:\\Users\\test\\project')).toBe('project');
    expect(resolveProjectFields('/Users/test/project').projectDisplay).toBe('project');
  });
});
