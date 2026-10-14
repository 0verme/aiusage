/**
 * AIUsage 免构建每日采集入口：只运行「已构建好的」CLI，永不执行 pnpm install / pnpm build。
 *
 * 为什么需要它：
 * 2026-10 的连续失败源于「构建 + 采集写在同一条命令里」。每日任务每次先尝试重建，而重建
 * 因为 pnpm 包管理器自解析失败（ERR_PNPM_LOCKFILE_WRITE_FILE / os error 6）必然失败，
 * 白白吃掉执行器的 30s 预算，随后采集阶段被杀死，导致连续 6 天数据没有上传。
 *
 * 本入口把两件事彻底分开：
 *   - 构建：由人 / CI 在独立步骤完成（`pnpm --filter @0verme/aiusage-cli build`）。
 *   - 采集：只读地运行 dist/cli.js，仅依赖 Node 内置模块（不需要 node_modules、不需要 pnpm）。
 *
 * 产物落后于源码时只**告警**，绝不自动重建：宁可照常采集（可能用了偏旧的定价目录），
 * 也不要因为构建失败而彻底停掉数据采集。
 *
 * 用法：
 *   node packages/cli/dist/daily-sync.js                  # 上传前一天（默认，推荐）
 *   node packages/cli/dist/daily-sync.js -- --today       # 上传当天
 *   node packages/cli/dist/daily-sync.js -- --range 7d    # 其余参数原样透传给 CLI
 *   node packages/cli/dist/daily-sync.js --bundle <path>
 *   AIUSAGE_CLI_BUNDLE=<path> AIUSAGE_REPO_ROOT=<path> node packages/cli/dist/daily-sync.js
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 会被打进 cli.js 的源码 / 配置输入；用于判断产物是否落后于源码。 */
const BUILD_INPUTS = [
  'packages/cli/src',
  'packages/shared/src',
  'packages/memory-core/src',
  'packages/pricing/src',
  'packages/cli/build.mjs',
  'packages/cli/package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
];

/** 已经指定目标日期的参数；出现任何一项就不再追加默认的 --yesterday。 */
const DATE_SELECTORS = ['--today', '--yesterday', '--range', '--date', '--from', '--to', '--start', '--end'];

/**
 * 信息类参数：只「查看」而不「执行」。
 *
 * 这类参数必须原样透传，绝不能补成 sync —— 否则一次 `--version` 会变成一次真实上传。
 * 这是实际踩到过的坑：`daily-sync.js -- --version` 曾经被改成 `sync --version --yesterday`，
 * CLI 忽略未知选项后直接开始扫描并准备上传。
 */
const INFORMATIONAL_FLAGS = ['--version', '-v', '--help', '-h'];

/** 构建写产物与源码 mtime 之间的抖动容差，避免误报「产物过期」。 */
export const STALE_TOLERANCE_MS = 2000;

/** 从本模块位置向上找 pnpm-workspace.yaml，兼容从 src/ 直接运行与从 dist/ 运行。 */
export function resolveRepoRoot(startDir: string = dirname(fileURLToPath(import.meta.url))): string {
  const fromEnv = process.env.AIUSAGE_REPO_ROOT?.trim();
  if (fromEnv) return resolve(fromEnv);

  let current = resolve(startDir);
  for (;;) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(startDir);
    current = parent;
  }
}

export interface DailySyncInspection {
  repoRoot: string;
  bundlePath: string;
  bundleExists: boolean;
  bundleMtimeMs: number;
  newestSourceMtimeMs: number;
  newestSourcePath?: string;
  /** 源码比产物新（超出容差）。只表示可能需要重建，不代表产物不可用。 */
  stale: boolean;
  buildInfo?: Record<string, unknown>;
}

export interface DailySyncArgs {
  bundlePath: string;
  cliArgs: string[];
}

/** 解析本脚车的参数；`--` 之后的内容原样透传给 CLI。 */
export function parseDailySyncArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  defaultBundlePath: string = join(resolveRepoRoot(), 'packages', 'cli', 'dist', 'cli.js'),
): DailySyncArgs {
  const separator = argv.indexOf('--');
  const own = separator === -1 ? [...argv] : argv.slice(0, separator);
  const forwarded = separator === -1 ? [] : argv.slice(separator + 1);

  let bundleOverride: string | undefined;
  const rest: string[] = [];
  for (let index = 0; index < own.length; index += 1) {
    if (own[index] === '--bundle') {
      bundleOverride = own[index + 1];
      index += 1;
      continue;
    }
    rest.push(own[index]);
  }

  const bundlePath = bundleOverride
    ? resolve(bundleOverride)
    : env.AIUSAGE_CLI_BUNDLE?.trim()
      ? resolve(env.AIUSAGE_CLI_BUNDLE.trim())
      : defaultBundlePath;

  return { bundlePath, cliArgs: forwarded.length > 0 ? forwarded : rest };
}

/** 组装最终传给 CLI 的参数：确保落在子命令上，并给 sync 补上默认日期。 */
export function resolveCliArgs(cliArgs: readonly string[]): string[] {
  const args = [...cliArgs];

  // 查看版本/帮助时不得注入子命令与日期，否则会真的触发一次同步上传。
  if (args.some((arg) => INFORMATIONAL_FLAGS.includes(arg))) return args;

  // 首个非选项参数视为子命令；没有子命令时默认 sync（与旧调度脚本的行为一致）。
  const hasSubcommand = args.length > 0 && !args[0].startsWith('-');
  if (!hasSubcommand) args.unshift('sync');

  // 只为 sync 补默认日期：其它子命令（scan/report/...）的日期语义不同，
  // 替它们编造 --yesterday 会产生错误行为。
  if (args[0] === 'sync' && !args.some((arg) => DATE_SELECTORS.includes(arg))) {
    args.push('--yesterday');
  }
  return args;
}

function maxMtimeMs(target: string, skip = new Set(['node_modules', 'dist', '.turbo', '.git'])): number {
  let newest = 0;
  const walk = (path: string): void => {
    let stats;
    try {
      stats = statSync(path);
    } catch {
      return;
    }
    if (stats.isDirectory()) {
      let entries;
      try {
        entries = readdirSync(path, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (skip.has(entry.name)) continue;
        walk(join(path, entry.name));
      }
      return;
    }
    if (stats.mtimeMs > newest) newest = stats.mtimeMs;
  };
  walk(target);
  return newest;
}

function readBuildInfo(bundlePath: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(join(dirname(bundlePath), 'build-info.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function describeBuildInfo(info?: Record<string, unknown>): string {
  if (!info) return 'unknown（dist/build-info.json 缺失，无法确认产物出自哪次提交）';
  const rawCommit = typeof info.commit === 'string' ? info.commit : 'unknown';
  const commit = rawCommit !== 'unknown' ? rawCommit.slice(0, 12) : 'unknown';
  const dirty = info.dirty === true ? '+dirty' : '';
  return `${info.version ?? 'unknown'} @ ${commit}${dirty} built ${info.builtAt ?? 'unknown'}`;
}

/** 纯检查函数（不执行同步），便于测试与运维排查。 */
export function inspectDailySync(
  options: { bundlePath?: string; repoRoot?: string; toleranceMs?: number } = {},
): DailySyncInspection {
  const repoRoot = options.repoRoot ?? resolveRepoRoot();
  const bundlePath = options.bundlePath ?? join(repoRoot, 'packages', 'cli', 'dist', 'cli.js');
  const toleranceMs = options.toleranceMs ?? STALE_TOLERANCE_MS;

  const bundleExists = existsSync(bundlePath);
  const bundleMtimeMs = bundleExists ? statSync(bundlePath).mtimeMs : 0;

  let newestSourceMtimeMs = 0;
  let newestSourcePath: string | undefined;
  for (const entry of BUILD_INPUTS) {
    const mtime = maxMtimeMs(join(repoRoot, entry));
    if (mtime > newestSourceMtimeMs) {
      newestSourceMtimeMs = mtime;
      newestSourcePath = entry;
    }
  }

  return {
    repoRoot,
    bundlePath,
    bundleExists,
    bundleMtimeMs,
    newestSourceMtimeMs,
    newestSourcePath,
    stale: bundleExists && newestSourceMtimeMs > bundleMtimeMs + toleranceMs,
    buildInfo: bundleExists ? readBuildInfo(bundlePath) : undefined,
  };
}

export function runDailySync(argv: readonly string[] = process.argv.slice(2)): number {
  const { bundlePath, cliArgs } = parseDailySyncArgs(argv);
  const inspection = inspectDailySync({ bundlePath });

  console.log('[daily-sync] 采集入口（不执行 install / build）');
  console.log(`[daily-sync] CLI 产物: ${bundlePath}`);

  if (!inspection.bundleExists) {
    console.error('[daily-sync] 未找到 CLI 产物。每日采集只运行已构建产物，不会自动构建。');
    console.error('[daily-sync] 请在独立步骤中构建：pnpm --filter @0verme/aiusage-cli build');
    console.error('[daily-sync] 或安装固定版本：npm install -g @0verme/aiusage-cli@<version>');
    return 2;
  }

  console.log(`[daily-sync] 构建来源: ${describeBuildInfo(inspection.buildInfo)}`);
  if (inspection.stale) {
    // 刻意只告警：产物落后不等于应当停采集，也绝不在采集路径里构建。
    console.warn(
      `[daily-sync] 警告: 产物早于源码（${inspection.newestSourcePath} 更新）。` +
      ' 本次仍继续采集；请在独立步骤中重新构建以更新定价与扫描器。',
    );
  }

  const args = resolveCliArgs(cliArgs);
  console.log(`[daily-sync] 执行: ${args.join(' ')}`);

  const result = spawnSync(process.execPath, [bundlePath, ...args], {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: process.env,
  });

  if (result.error) {
    console.error(`[daily-sync] 启动失败: ${result.error.message}`);
    return 2;
  }
  if (result.signal) {
    console.error(`[daily-sync] 进程被信号中断: ${result.signal}（上传结果未知，请核对服务端）`);
    return 3;
  }
  return result.status ?? 1;
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exitCode = runDailySync();
}
