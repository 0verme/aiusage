import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { IngestBreakdown } from '@aiusage/shared';

// 保留旧 scanner 的导入路径，但推断规则统一由 shared 提供。
export { inferProviderFromModel } from '@aiusage/shared';

/** 早于此刻视为脏数据下界（2015-01-01），用于过滤被误判单位的时间戳 */
const MIN_VALID_MS = Date.UTC(2015, 0, 1);

export function parseTs(value?: string | number): Date | null {
  if (value == null || value === '') return null;
  // 数值时间戳：区分秒级（10 位）与毫秒级（13 位）。
  // 形如 1775196391.26 的秒级值若按毫秒解析会落到 1970，需先 ×1000。
  let input: string | number = value;
  if (typeof value === 'number' || /^\d+(\.\d+)?$/.test(value)) {
    const num = typeof value === 'number' ? value : Number(value);
    input = num < 1e12 ? num * 1000 : num;
  }
  const d = new Date(input);
  const t = d.getTime();
  if (isNaN(t) || t < MIN_VALID_MS) return null;
  return d;
}

export function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** 文件内没有可靠时间戳时，以 mtime 兜底，避免有真实 token 的记录被静默丢弃。 */
export async function fileModifiedTs(filePath: string): Promise<Date | null> {
  try {
    return parseTs((await stat(filePath)).mtimeMs);
  } catch {
    return null;
  }
}

export function projectFromPath(raw: string, aliases?: Record<string, string>): string {
  const parts = raw.split(/[\\/]+/).filter(Boolean);
  const name = parts[parts.length - 1] || 'unknown';
  return aliases?.[raw] ?? aliases?.[name] ?? name;
}

export interface ProjectFields {
  project: string;
  projectDisplay: string;
  projectAlias?: string;
}

export function resolveProjectFields(
  rawPath: string,
  aliases?: Record<string, string>,
): ProjectFields {
  const parts = rawPath.split(/[\\/]+/).filter(Boolean);
  const display = parts[parts.length - 1] || 'unknown';
  const alias = aliases?.[rawPath] ?? aliases?.[display];
  return {
    project: rawPath || 'unknown',
    projectDisplay: display,
    projectAlias: alias,
  };
}

export async function walkFiles(dir: string, ext: string): Promise<string[]> {
  const result: string[] = [];
  await walk(dir, ext, result);
  return result;
}

async function walk(dir: string, ext: string, out: string[]): Promise<void> {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try { entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' }); } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, ext, out);
    else if (e.name.endsWith(ext)) out.push(full);
  }
}

export type DateGrouped = Map<string, Map<string, IngestBreakdown>>;

export function initDateMap(dates: Set<string>): DateGrouped {
  const m: DateGrouped = new Map();
  for (const d of dates) m.set(d, new Map());
  return m;
}

export function accumulate(
  grouped: Map<string, IngestBreakdown>,
  key: string,
  base: Omit<IngestBreakdown, 'eventCount'>,
  tokens: { input: number; cached: number; cacheWrite: number; output: number; reasoning: number },
): void {
  const existing = grouped.get(key);
  if (existing) {
    existing.eventCount += 1;
    existing.inputTokens += tokens.input;
    existing.cachedInputTokens += tokens.cached;
    existing.cacheWriteTokens += tokens.cacheWrite;
    existing.outputTokens += tokens.output;
    existing.reasoningOutputTokens += tokens.reasoning;
  } else {
    grouped.set(key, {
      ...base,
      eventCount: 1,
      inputTokens: tokens.input,
      cachedInputTokens: tokens.cached,
      cacheWriteTokens: tokens.cacheWrite,
      outputTokens: tokens.output,
      reasoningOutputTokens: tokens.reasoning,
    });
  }
}

export function finalize(groupedByDate: DateGrouped): Map<string, IngestBreakdown[]> {
  return new Map(
    [...groupedByDate.entries()].map(([d, m]) => [d, [...m.values()]]),
  );
}

export function emptyResult(dates: Set<string>): Map<string, IngestBreakdown[]> {
  return new Map([...dates].map(d => [d, []]));
}

// 生成旧 scanner 使用的 pricing-compatible key：去掉日期后缀（如
// claude-3-5-sonnet-20241022 → claude-3-5-sonnet）和上下文窗口标记。
// 这不是 canonical/display normalization；调用方必须在 rawModel 中保留原值。
export function normalizeModelName(name: string): string {
  return name
    .replace(/\[\d+[a-zA-Z]*\]$/, '')
    .replace(/-\d{8}$/, '');
}

/**
 * Attach the scanner-level pricing key without losing the source model.
 * Callers that have a source-specific pricing normalization pass it as the
 * second argument; the default deliberately keeps the raw value unchanged.
 * `model` remains the legacy pricing-compatible field; canonical/display
 * normalization is intentionally deferred to shared/Worker/Dashboard code.
 */
export function scannerModelFields(
  rawModel: string | undefined | null,
  pricingModelKey = rawModel ?? '',
): Pick<IngestBreakdown, 'model' | 'rawModel' | 'pricingModelKey'> {
  const raw = rawModel?.trim() || 'unknown';
  const pricing = pricingModelKey.trim() || 'unknown';
  return pricing === raw
    ? { model: pricing }
    : { model: pricing, rawModel: raw, pricingModelKey: pricing };
}

// Pool-based 并发控制，避免同时打开过多文件句柄
export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;
  const runWorker = async (): Promise<void> => {
    for (;;) {
      const i = nextIndex++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: limit }, () => runWorker()));
}

/**
 * 目标日期集合的窗口下界（本地零点），与 dateKey() 的本地时区语义保持一致。
 * 日期为空或格式非法时返回 undefined，调用方应视为“不启用窗口过滤”。
 */
export function dateWindowStartMs(dates: Iterable<string>): number | undefined {
  let start: number | undefined;
  for (const value of dates) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) continue;
    const ms = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
    if (!Number.isFinite(ms)) continue;
    if (start === undefined || ms < start) start = ms;
  }
  return start;
}

/**
 * mtime 预过滤的保守安全边界，默认 7 天。
 *
 * 预过滤的推导前提是「追加写入 ⇒ 文件 mtime 不小于文件内任何记录的时间戳」。
 * 该前提在下列情况下会被打破，此时若直接按窗口下界裁剪就会漏掉窗口内的记录：
 *   - 系统时钟回拨（先写出带较新时间戳的记录，再以旧 mtime 落盘）；
 *   - 写入方时区理解错误（把本地时间当 UTC 解释，可让记录时间戳比 mtime 大最多 8 小时）；
 *   - 会话文件从其它机器/备份按原 mtime 回灌，而对方时钟与本机不一致。
 *
 * 因此只有当 mtime 比窗口下界早出这个边界时才真的跳过。实测本机 Pi 会话库
 * （786 文件 / 1057 MB）在 7 天下仍能跳过 94.66% 的文件、只需读 69.65 MB，
 * 代价可以忽略。
 */
export const MTIME_PREFILTER_MARGIN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 保留全部文件、不做 mtime 裁剪。
 *
 * 当运维怀疑时钟异常、时区错位或刚做过历史回灌时，可用它强制全量扫描，
 * 作为“宁可慢、不可错”的逃生通道：`AIUSAGE_MTIME_PREFILTER=off`。
 */
export function isMtimePrefilterEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.AIUSAGE_MTIME_PREFILTER?.trim().toLowerCase();
  if (!value) return true;
  return !['off', '0', 'false', 'no', 'disabled', 'disable'].includes(value);
}

/**
 * 丢弃 mtime 明显早于窗口下界的会话文件，避免用单日扫描读取整段历史。
 *
 * 安全策略（任何一项不满足都回退到“保留文件”）：
 *   1. 未提供窗口下界（例如 --range all）→ 不过滤；
 *   2. AIUSAGE_MTIME_PREFILTER=off → 不过滤；
 *   3. stat 失败或抛错 → 保留；
 *   4. mtime 非有限值，或早于 2015-01-01（与 parseTs 的脏数据下界一致）→ 保留；
 *   5. 只当 mtime < 窗口下界 − MTIME_PREFILTER_MARGIN_MS 时才跳过。
 *
 * 因此判定为“跳过”需要同时满足「stat 成功」和「mtime 正常且足够旧」两个条件，
 * 任何异常一律保守保留，交给读取阶段决定。
 */
export async function filterFilesModifiedSince(
  files: readonly string[],
  windowStartMs: number | undefined,
  concurrency = 16,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  if (windowStartMs === undefined || files.length === 0) return [...files];
  if (!isMtimePrefilterEnabled(env)) return [...files];

  const cutoffMs = windowStartMs - MTIME_PREFILTER_MARGIN_MS;
  // 默认保留：只有同时确认 stat 成功且 mtime 正常且确实过旧，才置为 false。
  const keep = new Array<boolean>(files.length).fill(true);
  await runWithConcurrency([...files], concurrency, async (filePath, index) => {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(filePath)).mtimeMs;
    } catch {
      return;
    }
    if (!Number.isFinite(mtimeMs) || mtimeMs < MIN_VALID_MS) return;
    keep[index] = mtimeMs >= cutoffMs;
  });
  return files.filter((_, index) => keep[index]);
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  await runWithConcurrency(items, concurrency, async (item, index) => {
    results[index] = await worker(item, index);
  });
  return results;
}
