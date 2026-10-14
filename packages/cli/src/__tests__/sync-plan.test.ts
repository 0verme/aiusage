import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MEMORY_STAGE_TIMEOUT_MS,
  StageTimeoutError,
  planSyncDays,
  resolveMemoryStageTimeoutMs,
  withStageTimeout,
} from '../sync-plan.js';

describe('planSyncDays', () => {
  it('仅上传确实扫到 token 明细的日期', () => {
    const plan = planSyncDays([
      { usageDate: '2026-10-07', breakdownCount: 2, activityItemCount: 5 },
      { usageDate: '2026-10-08', breakdownCount: 0, activityItemCount: 3 },
      { usageDate: '2026-10-09', breakdownCount: 1, activityItemCount: 0 },
    ]);

    expect(plan.uploadDates).toEqual(['2026-10-07', '2026-10-09']);
    expect(plan.skippedEmptyTokenDates).toEqual(['2026-10-08']);
  });

  it('拒绝空 token 快照，避免服务端该日汇总被清零', () => {
    // 这正是事故中的危险场景：activity 有数据但 token 扫描没产出。
    // 服务端 ingest 对整天做 DELETE + 重插，发送空 breakdown 会删光明细，
    // 因此这里必须选择「少传一天」而不是「覆盖历史」。
    const plan = planSyncDays([
      { usageDate: '2026-10-08', breakdownCount: 0, activityItemCount: 42 },
    ]);

    expect(plan.uploadDates).toEqual([]);
    expect(plan.skippedEmptyTokenDates).toEqual(['2026-10-08']);
  });

  it('既没有 token 也没有 activity 的日期被静默丢弃', () => {
    const plan = planSyncDays([
      { usageDate: '2026-10-08', breakdownCount: 0, activityItemCount: 0 },
    ]);

    expect(plan.uploadDates).toEqual([]);
    expect(plan.skippedEmptyTokenDates).toEqual([]);
  });

  it('没有任何日期时返回空计划', () => {
    expect(planSyncDays([])).toEqual({ uploadDates: [], skippedEmptyTokenDates: [] });
  });

  it('保持输入顺序，便于日志与上传顺序稳定', () => {
    const plan = planSyncDays([
      { usageDate: '2026-10-03', breakdownCount: 1, activityItemCount: 0 },
      { usageDate: '2026-10-01', breakdownCount: 1, activityItemCount: 0 },
      { usageDate: '2026-10-02', breakdownCount: 0, activityItemCount: 1 },
    ]);

    expect(plan.uploadDates).toEqual(['2026-10-03', '2026-10-01']);
    expect(plan.skippedEmptyTokenDates).toEqual(['2026-10-02']);
  });
});

describe('resolveMemoryStageTimeoutMs', () => {
  it('默认给出有界的超时时间', () => {
    expect(resolveMemoryStageTimeoutMs({} as NodeJS.ProcessEnv)).toBe(DEFAULT_MEMORY_STAGE_TIMEOUT_MS);
    expect(DEFAULT_MEMORY_STAGE_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('允许用 AIUSAGE_MEMORY_TIMEOUT_MS 覆盖', () => {
    expect(resolveMemoryStageTimeoutMs({ AIUSAGE_MEMORY_TIMEOUT_MS: '5000' } as NodeJS.ProcessEnv)).toBe(5000);
    expect(resolveMemoryStageTimeoutMs({ AIUSAGE_MEMORY_TIMEOUT_MS: ' 1500 ' } as NodeJS.ProcessEnv)).toBe(1500);
  });

  it('非法值回退到默认值，显式关闭则返回 undefined', () => {
    expect(resolveMemoryStageTimeoutMs({ AIUSAGE_MEMORY_TIMEOUT_MS: 'abc' } as NodeJS.ProcessEnv))
      .toBe(DEFAULT_MEMORY_STAGE_TIMEOUT_MS);
    expect(resolveMemoryStageTimeoutMs({ AIUSAGE_MEMORY_TIMEOUT_MS: '-1' } as NodeJS.ProcessEnv))
      .toBe(DEFAULT_MEMORY_STAGE_TIMEOUT_MS);
    expect(resolveMemoryStageTimeoutMs({ AIUSAGE_MEMORY_TIMEOUT_MS: 'off' } as NodeJS.ProcessEnv))
      .toBeUndefined();
    expect(resolveMemoryStageTimeoutMs({ AIUSAGE_MEMORY_TIMEOUT_MS: '0' } as NodeJS.ProcessEnv))
      .toBeUndefined();
  });
});

describe('withStageTimeout', () => {
  it('任务按时完成时返回结果并清理定时器', async () => {
    await expect(withStageTimeout('Memory', 1000, async () => 'done')).resolves.toBe('done');
  });

  it('任务超时后抛出 StageTimeoutError 并 abort 信号', async () => {
    let observedSignal: AbortSignal | undefined;
    const hung = withStageTimeout('Memory', 20, async (signal) => {
      observedSignal = signal;
      await new Promise(() => { /* 永不结束 */ });
      return 'never';
    });

    await expect(hung).rejects.toBeInstanceOf(StageTimeoutError);
    await expect(hung).rejects.toMatchObject({ label: 'Memory', timeoutMs: 20 });
    expect(observedSignal?.aborted).toBe(true);
  });

  it('超时不会让关键路径继续等待（上传路径可立即继续）', async () => {
    vi.useFakeTimers();
    try {
      const started = Date.now();
      const pending = withStageTimeout('Memory', 50, async () => {
        await new Promise(() => { /* 永不结束 */ });
        return 'never';
      });
      const settled = pending.catch((error) => (error instanceof StageTimeoutError ? 'timeout' : 'other'));
      await vi.advanceTimersByTimeAsync(60);

      await expect(settled).resolves.toBe('timeout');
      expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    } finally {
      vi.useRealTimers();
    }
  });

  it('超时后任务再失败也不会产生 unhandledRejection', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => { rejections.push(reason); };
    process.on('unhandledRejection', onRejection);

    try {
      let rejectLate: ((error: Error) => void) | undefined;
      const task = withStageTimeout('Memory', 10, () =>
        new Promise<string>((_, reject) => { rejectLate = reject; }));

      await expect(task).rejects.toBeInstanceOf(StageTimeoutError);
      rejectLate?.(new Error('late failure after timeout'));
      // 让微任务/定时器有机会上报未处理拒绝。
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('timeoutMs 为 undefined 时退化为无超时等待', async () => {
    await expect(withStageTimeout('Memory', undefined, async () => 'unbounded')).resolves.toBe('unbounded');
  });

  it('任务自身抛错时原样冒泡，不被误判为超时', async () => {
    const boom = new Error('scanner exploded');
    await expect(withStageTimeout('Memory', 1000, async () => { throw boom; })).rejects.toBe(boom);
  });
});
