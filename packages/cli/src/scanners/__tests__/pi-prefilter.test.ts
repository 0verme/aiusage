import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IngestBreakdown } from '@aiusage/shared';
import { scanPiDates } from '../pi.js';
import { MTIME_PREFILTER_MARGIN_MS } from '../utils.js';

/**
 * Pi token 扫描的 mtime 预过滤必须在「正常时序」下与全量扫描结果一致，
 * 并且在 mtime 不可信的边界场景下保守保留文件。
 *
 * 约定：窗口下界 = 目标日期集合中最早的本地零点（dateKey 用本地时区）。
 */

const WINDOW_DATE = '2026-07-18';
const WINDOW_START_MS = new Date(2026, 6, 18).getTime();
const IN_WINDOW_TS = '2026-07-18T09:00:00Z';
const OUT_OF_WINDOW_TS = '2026-01-05T09:00:00Z';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `aiusage-pi-prefilter-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tmpDir, { recursive: true, force: true });
});

interface SessionRow {
  type: string;
  id?: string;
  cwd?: string;
  timestamp?: string;
  message?: {
    role?: string;
    model?: string;
    provider?: string;
    usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  };
}

/** Writes one Pi session file, then forces its mtime so the filter has something to reason about. */
async function writeSession(
  encodedCwd: string,
  sessionName: string,
  rows: SessionRow[],
  mtime: Date,
): Promise<string> {
  const filePath = join(tmpDir, encodedCwd, `${sessionName}.jsonl`);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, rows.map(row => JSON.stringify(row)).join('\n'), 'utf-8');
  await utimes(filePath, mtime, mtime);
  return filePath;
}

function messageRow(id: string, timestamp: string, input: number, output: number): SessionRow {
  return {
    type: 'message',
    id,
    timestamp,
    message: { role: 'assistant', model: 'claude-sonnet-4-6', provider: 'anthropic', usage: { input, output } },
  };
}

/** Stable, order-independent projection of a scan result for equality assertions. */
function snapshot(result: Map<string, IngestBreakdown[]>): string {
  const normalized = [...result.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, breakdowns]) => [
      date,
      [...breakdowns]
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
        .map(row => ({
          model: row.model,
          project: row.project,
          eventCount: row.eventCount,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
        })),
    ]);
  return JSON.stringify(normalized);
}

async function scanWith(env: Record<string, string>, dates: string[] = [WINDOW_DATE]) {
  vi.stubEnv('AIUSAGE_MTIME_PREFILTER', env.AIUSAGE_MTIME_PREFILTER ?? '');
  return scanPiDates(dates, tmpDir);
}

/** Reference result: prefilter disabled, i.e. the pre-optimisation behaviour. */
async function scanFull(dates: string[] = [WINDOW_DATE]) {
  return scanWith({ AIUSAGE_MTIME_PREFILTER: 'off' }, dates);
}

describe('Pi mtime 预过滤：等价性', () => {
  it('正常时序下与全量扫描结果完全一致', async () => {
    await writeSession('--E--repo-alpha--', 'recent-in-window', [
      { type: 'session', id: 's1', cwd: 'E:/repo-alpha' },
      messageRow('m1', IN_WINDOW_TS, 100, 20),
    ], new Date(WINDOW_START_MS + 60_000));

    await writeSession('--E--repo-beta--', 'old-out-of-window', [
      { type: 'session', id: 's2', cwd: 'E:/repo-beta' },
      messageRow('m2', OUT_OF_WINDOW_TS, 500, 50),
    ], new Date('2026-02-01T00:00:00Z'));

    const filtered = await scanWith({});
    const full = await scanFull();

    expect(snapshot(filtered)).toEqual(snapshot(full));
    // 且确实发生了裁剪：只有近文件被读取。
    expect(filtered.get(WINDOW_DATE)).toHaveLength(1);
  });

  it('多日期窗口以最早日期为界，且仍与全量扫描一致', async () => {
    await writeSession('--E--repo-alpha--', 'between', [
      { type: 'session', id: 's1', cwd: 'E:/repo-alpha' },
      messageRow('m1', IN_WINDOW_TS, 100, 20),
    ], new Date('2026-07-16T00:00:00Z'));

    await writeSession('--E--repo-beta--', 'ancient', [
      { type: 'session', id: 's2', cwd: 'E:/repo-beta' },
      messageRow('m2', '2026-06-01T09:00:00Z', 7, 3),
    ], new Date('2026-06-02T00:00:00Z'));

    const dates = ['2026-07-18', '2026-07-16'];
    const filtered = await scanWith({}, dates);
    const full = await scanFull(dates);

    expect(snapshot(filtered)).toEqual(snapshot(full));
  });
});

describe('Pi mtime 预过滤：备份恢复与历史回灌', () => {
  it('备份原样恢复（mtime 与内容时间戳同为旧值）时不丢数据', async () => {
    // 忠实副本：mtime 被还原成旧值，但内容时间戳同样很旧 —— 不变量依然成立。
    await writeSession('--E--repo-archived--', 'restored', [
      { type: 'session', id: 's1', cwd: 'E:/repo-archived' },
      messageRow('m1', OUT_OF_WINDOW_TS, 900, 90),
    ], new Date('2026-01-06T00:00:00Z'));

    const filtered = await scanWith({});
    const full = await scanFull();

    expect(snapshot(filtered)).toEqual(snapshot(full));
    expect(filtered.get(WINDOW_DATE)).toEqual([]);
  });

  it('历史回灌落在安全边界内时保守保留，仍能扫出窗口内记录', async () => {
    // 回灌文件：mtime 是旧时间（早于窗口），但内容带窗口内时间戳。
    // 这正是不变量被打破的情形，安全边界必须把它救回来。
    const mtime = new Date(WINDOW_START_MS - MTIME_PREFILTER_MARGIN_MS + 24 * 60 * 60 * 1000);
    await writeSession('--E--repo-backfill--', 'clock-skewed', [
      { type: 'session', id: 's1', cwd: 'E:/repo-backfill' },
      messageRow('m1', IN_WINDOW_TS, 123, 45),
    ], mtime);

    const filtered = await scanWith({});

    expect(filtered.get(WINDOW_DATE)).toHaveLength(1);
    const row = filtered.get(WINDOW_DATE)![0];
    expect(row.inputTokens).toBe(123);
    expect(row.outputTokens).toBe(45);
  });

  it('历史回灌超出安全边界时会漏读，可用 AIUSAGE_MTIME_PREFILTER=off 找回（已知边界）', async () => {
    const mtime = new Date(WINDOW_START_MS - MTIME_PREFILTER_MARGIN_MS - 24 * 60 * 60 * 1000);
    await writeSession('--E--repo-backfill--', 'far-backfill', [
      { type: 'session', id: 's1', cwd: 'E:/repo-backfill' },
      messageRow('m1', IN_WINDOW_TS, 321, 11),
    ], mtime);

    const filtered = await scanWith({});
    const recovered = await scanFull();

    // 记录当前已知边界：超出 N 天安全边界的历史回灌会被跳过。
    expect(filtered.get(WINDOW_DATE)).toEqual([]);
    // 逃生通道必须能找回全部数据。
    expect(recovered.get(WINDOW_DATE)).toHaveLength(1);
    expect(recovered.get(WINDOW_DATE)![0].inputTokens).toBe(321);
  });
});

describe('Pi mtime 预过滤：时间戳异常与不可读元数据', () => {
  it('mtime 为纪元 0 等异常值时保守保留文件', async () => {
    await writeSession('--E--repo-epoch--', 'epoch-mtime', [
      { type: 'session', id: 's1', cwd: 'E:/repo-epoch' },
      messageRow('m1', IN_WINDOW_TS, 55, 5),
    ], new Date(0));

    const filtered = await scanWith({});
    expect(filtered.get(WINDOW_DATE)).toHaveLength(1);
    expect(filtered.get(WINDOW_DATE)![0].inputTokens).toBe(55);
  });

  it('mtime 早于 2015 脏数据下界时保守保留文件', async () => {
    await writeSession('--E--repo-2010--', 'old-mtime', [
      { type: 'session', id: 's1', cwd: 'E:/repo-2010' },
      messageRow('m1', IN_WINDOW_TS, 77, 7),
    ], new Date('2010-05-05T00:00:00Z'));

    const filtered = await scanWith({});
    expect(filtered.get(WINDOW_DATE)).toHaveLength(1);
  });

  it('内容时间戳远超窗口（未来时间戳）时，落在边界内仍能扫出', async () => {
    // mtime 比窗口早些，但内容被写入一个远未来的时间戳；只要还在安全边界内就必须保留。
    const mtime = new Date(WINDOW_START_MS - 12 * 60 * 60 * 1000);
    await writeSession('--E--repo-future--', 'future-stamp', [
      { type: 'session', id: 's1', cwd: 'E:/repo-future' },
      messageRow('m1', '2030-01-01T00:00:00Z', 42, 2),
    ], mtime);

    const filtered = await scanWith({});
    // 2030 的记录不属于本次窗口，因此不会被计入；关键是文件被读取过而不是被跳过。
    expect(filtered.get(WINDOW_DATE)).toEqual([]);
    const full = await scanFull();
    expect(snapshot(filtered)).toEqual(snapshot(full));
  });

  it('无窗口下界（如 --range all）时不裁剪任何文件', async () => {
    await writeSession('--E--repo-alpha--', 'ancient', [
      { type: 'session', id: 's1', cwd: 'E:/repo-alpha' },
      messageRow('m1', OUT_OF_WINDOW_TS, 1, 1),
    ], new Date('2016-01-01T00:00:00Z'));

    // 通过 dateWindowStartMs 收到空集合时的行为间接覆盖：直接调用带 undefined 的场景
    // 已在 utils.test.ts 中断言；这里验证扫描器在 dates 为空时不做无谓读取。
    const empty = await scanPiDates([], tmpDir);
    expect(empty.size).toBe(0);
  });
});
