/**
 * 同步阶段的计划与超时保障。
 *
 * 这里的逻辑刻意与 CLI 输出、网络、扫描器解耦，方便直接用单元测试固定住
 * 「不因非核心阶段拖死上传」和「不上传不完整快照」两条约束。
 */

/** 某个目标日期在本地扫描后的可用素材。 */
export interface SyncDayCandidate {
  usageDate: string;
  /** 该日 token 明细条数（0 表示本次没有扫到任何 token 快照）。 */
  breakdownCount: number;
  /** 该日 activity 条目数。 */
  activityItemCount: number;
}

export interface SyncDayPlan {
  /**
   * 可以安全上传的日期：本次确实扫到了 token 明细。
   *
   * 服务端 `POST /api/v1/ingest/daily` 对每一天执行的是
   * `INSERT daily_usage ... ON CONFLICT DO UPDATE` + 先 `DELETE daily_usage_breakdown`
   * 再重插，即「整天替换」。若发送 0 条 breakdown，服务端不会报错，而是会把该日
   * 已有的 token 汇总清零并删掉全部明细 —— 所以一个空 token 快照永远不是合法意图，
   * 必须在上传前就挡掉。
   */
  uploadDates: string[];
  /** 观测到 activity 但没有 token 明细、为避免覆盖服务端历史而主动跳过的日期。 */
  skippedEmptyTokenDates: string[];
}

/**
 * 决定哪些日期可以进入上传集合。
 *
 * - 有 token 明细 → 上传（这是完整快照）。
 * - 没有 token 明细但有 activity → 跳过并上报，绝不发送空 token 快照。
 * - 两者都没有 → 静默丢弃（本来就没有任何东西可传）。
 *
 * 保守方向是明确的：跳过最多让人少传一天，上传空快照却会破坏服务端已有数据。
 */
export function planSyncDays(candidates: readonly SyncDayCandidate[]): SyncDayPlan {
  const uploadDates: string[] = [];
  const skippedEmptyTokenDates: string[] = [];

  for (const candidate of candidates) {
    if (candidate.breakdownCount > 0) {
      uploadDates.push(candidate.usageDate);
      continue;
    }
    if (candidate.activityItemCount > 0) {
      skippedEmptyTokenDates.push(candidate.usageDate);
    }
  }

  return { uploadDates, skippedEmptyTokenDates };
}

/** 非核心阶段超时；只描述事实，本地化文案交给调用方。 */
export class StageTimeoutError extends Error {
  readonly label: string;
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number) {
    super(`${label} stage exceeded ${timeoutMs} ms`);
    this.name = 'StageTimeoutError';
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

/** Memory 阶段的默认超时；本机实测该阶段耗时约 1.6s，60s 已属宽裕。 */
export const DEFAULT_MEMORY_STAGE_TIMEOUT_MS = 60_000;

/**
 * 读取 Memory 阶段超时。`AIUSAGE_MEMORY_TIMEOUT_MS=off`（或 0）表示不设超时，
 * 退回旧行为，便于排查问题时需要完整等待。
 */
export function resolveMemoryStageTimeoutMs(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.AIUSAGE_MEMORY_TIMEOUT_MS?.trim().toLowerCase();
  if (!raw) return DEFAULT_MEMORY_STAGE_TIMEOUT_MS;
  if (['off', '0', 'false', 'no', 'disabled', 'disable'].includes(raw)) return undefined;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MEMORY_STAGE_TIMEOUT_MS;
  return parsed;
}

/**
 * 给非核心阶段套一个墙钟上限，超时后 abort 信号并把控制权交回调用方。
 *
 * 目的是把「关键路径」和「可选阶段」解耦：Memory 无论多慢，都不能再让
 * token 扫描 + 上传无限期等待。超时只保证不再阻塞上传；已经进入单文件读取的
 * 工作会在线程池里自然结束，因此同时下发 AbortSignal 让扫描在文件边界尽快停下。
 */
export async function withStageTimeout<T>(
  label: string,
  timeoutMs: number | undefined,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (timeoutMs === undefined) {
    return task(new AbortController().signal);
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new StageTimeoutError(label, timeoutMs));
    }, timeoutMs);
  });

  const work = task(controller.signal);
  // 超时之后 work 仍可能 reject；先挂一个空 catch，避免 unhandledRejection 终止进程。
  work.catch(() => undefined);

  try {
    return await Promise.race([work, expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
