import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  STALE_TOLERANCE_MS,
  describeBuildInfo,
  inspectDailySync,
  parseDailySyncArgs,
  resolveCliArgs,
  resolveRepoRoot,
} from '../daily-sync.js';

let tmpDir: string;
const savedEnv = { AIUSAGE_CLI_BUNDLE: process.env.AIUSAGE_CLI_BUNDLE, AIUSAGE_REPO_ROOT: process.env.AIUSAGE_REPO_ROOT };

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'aiusage-daily-sync-'));
  delete process.env.AIUSAGE_CLI_BUNDLE;
  delete process.env.AIUSAGE_REPO_ROOT;
});

afterEach(async () => {
  if (savedEnv.AIUSAGE_CLI_BUNDLE === undefined) delete process.env.AIUSAGE_CLI_BUNDLE;
  else process.env.AIUSAGE_CLI_BUNDLE = savedEnv.AIUSAGE_CLI_BUNDLE;
  if (savedEnv.AIUSAGE_REPO_ROOT === undefined) delete process.env.AIUSAGE_REPO_ROOT;
  else process.env.AIUSAGE_REPO_ROOT = savedEnv.AIUSAGE_REPO_ROOT;
  await rm(tmpDir, { recursive: true, force: true });
});

/** 构造一个最小的假仓库：pnpm-workspace.yaml + dist 产物 + 源码。 */
async function makeFakeRepo(options: { bundleExists?: boolean; bundleMtime: Date; sourceMtime: Date }) {
  const repoRoot = join(tmpDir, 'repo');
  await mkdir(join(repoRoot, 'packages', 'cli', 'dist'), { recursive: true });
  await mkdir(join(repoRoot, 'packages', 'cli', 'src'), { recursive: true });
  // pnpm-workspace.yaml / pnpm-lock.yaml 也是构建输入，固定 mtime 免得被「刚刚写入」干扰。
  const configMtime = new Date(2020, 0, 1);
  for (const [name, body] of [['pnpm-workspace.yaml', 'packages:\n  - "packages/*"\n'], ['pnpm-lock.yaml', 'lockfileVersion: "9.0"\n']] as const) {
    const filePath = join(repoRoot, name);
    await writeFile(filePath, body);
    await utimes(filePath, configMtime, configMtime);
  }

  const sourcePath = join(repoRoot, 'packages', 'cli', 'src', 'cli.ts');
  await writeFile(sourcePath, '// source\n');
  await utimes(sourcePath, options.sourceMtime, options.sourceMtime);

  const bundlePath = join(repoRoot, 'packages', 'cli', 'dist', 'cli.js');
  if (options.bundleExists !== false) {
    await writeFile(bundlePath, '// bundle\n');
    await utimes(bundlePath, options.bundleMtime, options.bundleMtime);
  }
  return { repoRoot, bundlePath, sourcePath };
}

describe('resolveCliArgs', () => {
  it('默认补上 sync --yesterday（与旧的每日调度语义一致）', () => {
    expect(resolveCliArgs([])).toEqual(['sync', '--yesterday']);
  });

  it('用户显式给出日期时不再追加 --yesterday', () => {
    expect(resolveCliArgs(['--today'])).toEqual(['sync', '--today']);
    expect(resolveCliArgs(['sync', '--range', '7d'])).toEqual(['sync', '--range', '7d']);
    expect(resolveCliArgs(['--from', '2026-10-01', '--to', '2026-10-09']))
      .toEqual(['sync', '--from', '2026-10-01', '--to', '2026-10-09']);
  });

  it('不替非 sync 子命令编造日期参数', () => {
    expect(resolveCliArgs(['scan', '--tool', 'pi'])).toEqual(['scan', '--tool', 'pi']);
    expect(resolveCliArgs(['doctor'])).toEqual(['doctor']);
  });

  it('--version / --help 必须原样透传，绝不能变成一次同步上传', () => {
    // 回归护栏：曾经变成 sync --version --yesterday，CLI 忽略未知选项后真的开始扫描。
    expect(resolveCliArgs(['--version'])).toEqual(['--version']);
    expect(resolveCliArgs(['-v'])).toEqual(['-v']);
    expect(resolveCliArgs(['--help'])).toEqual(['--help']);
    expect(resolveCliArgs(['-h'])).toEqual(['-h']);
    for (const args of [['--version'], ['--help'], ['-v'], ['-h']]) {
      expect(resolveCliArgs(args)).not.toContain('sync');
      expect(resolveCliArgs(args)).not.toContain('--yesterday');
    }
  });
});

describe('parseDailySyncArgs', () => {
  it('提取 --bundle 并把剩余参数作为 CLI 参数', () => {
    const parsed = parseDailySyncArgs(['--bundle', join(tmpDir, 'x.js'), '--today']);
    expect(parsed.bundlePath).toBe(join(tmpDir, 'x.js'));
    expect(parsed.cliArgs).toEqual(['--today']);
  });

  it('支持 `--` 之后原样透传', () => {
    const parsed = parseDailySyncArgs(['--bundle', join(tmpDir, 'x.js'), '--', 'sync', '--range', '7d']);
    expect(parsed.cliArgs).toEqual(['sync', '--range', '7d']);
  });

  it('AIUSAGE_CLI_BUNDLE 作为路径覆盖', () => {
    process.env.AIUSAGE_CLI_BUNDLE = join(tmpDir, 'env-bundle.js');
    expect(parseDailySyncArgs([]).bundlePath).toBe(join(tmpDir, 'env-bundle.js'));
  });

  it('默认指向仓库内的 packages/cli/dist/cli.js', () => {
    expect(parseDailySyncArgs([]).bundlePath.endsWith(join('packages', 'cli', 'dist', 'cli.js'))).toBe(true);
  });

  it('--bundle 优先于环境变量', () => {
    process.env.AIUSAGE_CLI_BUNDLE = join(tmpDir, 'env-bundle.js');
    expect(parseDailySyncArgs(['--bundle', join(tmpDir, 'flag-bundle.js')]).bundlePath)
      .toBe(join(tmpDir, 'flag-bundle.js'));
  });
});

describe('inspectDailySync', () => {
  it('产物缺失时报告 bundleExists=false 且不误报过期', async () => {
    const { repoRoot, bundlePath } = await makeFakeRepo({
      bundleExists: false,
      bundleMtime: new Date(2026, 9, 1),
      sourceMtime: new Date(2026, 9, 2),
    });

    const result = inspectDailySync({ repoRoot, bundlePath });
    expect(result.bundleExists).toBe(false);
    expect(result.stale).toBe(false);
    expect(result.buildInfo).toBeUndefined();
  });

  it('产物比源码新时不报过期', async () => {
    const { repoRoot, bundlePath } = await makeFakeRepo({
      bundleMtime: new Date(2026, 9, 10),
      sourceMtime: new Date(2026, 9, 1),
    });

    const result = inspectDailySync({ repoRoot, bundlePath });
    expect(result.bundleExists).toBe(true);
    expect(result.stale).toBe(false);
  });

  it('源码比产物新时标记过期（只告警，不重建）', async () => {
    const { repoRoot, bundlePath } = await makeFakeRepo({
      bundleMtime: new Date(2026, 9, 1),
      sourceMtime: new Date(2026, 9, 10),
    });

    const result = inspectDailySync({ repoRoot, bundlePath });
    expect(result.stale).toBe(true);
    expect(result.newestSourcePath).toBe('packages/cli/src');
  });

  it('容差范围内的极小 mtime 差异不算过期，超出容差则报出', async () => {
    const base = new Date(2026, 9, 10).getTime();
    const { repoRoot, bundlePath } = await makeFakeRepo({
      bundleMtime: new Date(base),
      // 源码比产物新，但只新出半个容差。
      sourceMtime: new Date(base + Math.floor(STALE_TOLERANCE_MS / 2)),
    });

    expect(inspectDailySync({ repoRoot, bundlePath }).stale).toBe(false);
    // 把容差压到 0，同样的事实就必须报出来。
    expect(inspectDailySync({ repoRoot, bundlePath, toleranceMs: 0 }).stale).toBe(true);
  });

  it('读取 build-info.json 作为来源凭据', async () => {
    const { repoRoot, bundlePath } = await makeFakeRepo({
      bundleMtime: new Date(2026, 9, 10),
      sourceMtime: new Date(2026, 9, 1),
    });
    await writeFile(
      join(dirname(bundlePath), 'build-info.json'),
      JSON.stringify({ version: '1.1.0', commit: 'abcdef1234567890', dirty: false, builtAt: '2026-10-14T00:00:00Z' }),
    );

    const result = inspectDailySync({ repoRoot, bundlePath });
    expect(result.buildInfo).toMatchObject({ version: '1.1.0', commit: 'abcdef1234567890' });
  });
});

describe('describeBuildInfo', () => {
  it('缺失时明确说明无法确认提交', () => {
    expect(describeBuildInfo(undefined)).toContain('dist/build-info.json 缺失');
  });

  it('展示版本、短提交号与构建时间', () => {
    const text = describeBuildInfo({
      version: '1.1.0',
      commit: 'abcdef1234567890abcdef',
      dirty: false,
      builtAt: '2026-10-14T00:00:00Z',
    });
    expect(text).toContain('1.1.0');
    expect(text).toContain('abcdef123456');
    expect(text).toContain('2026-10-14T00:00:00Z');
    expect(text).not.toContain('+dirty');
  });

  it('标记脏工作区构建与未知提交', () => {
    expect(describeBuildInfo({ version: '1.1.0', commit: 'unknown', dirty: true, builtAt: 'x' })).toContain('+dirty');
    expect(describeBuildInfo({ version: '1.1.0', commit: 'unknown', dirty: true, builtAt: 'x' })).toContain('unknown');
  });
});

describe('resolveRepoRoot', () => {
  it('从源码目录向上找到带 pnpm-workspace.yaml 的仓库根', () => {
    const root = resolveRepoRoot(join(process.cwd(), 'src'));
    expect(existsSync(join(root, 'pnpm-workspace.yaml'))).toBe(true);
  });

  it('AIUSAGE_REPO_ROOT 覆盖自动探测', async () => {
    const { repoRoot } = await makeFakeRepo({
      bundleMtime: new Date(2026, 9, 10),
      sourceMtime: new Date(2026, 9, 1),
    });
    process.env.AIUSAGE_REPO_ROOT = repoRoot;
    expect(resolveRepoRoot()).toBe(repoRoot);
  });
});
