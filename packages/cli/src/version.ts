import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | undefined;

export function getVersion(): string {
  if (cached !== undefined) return cached;
  try {
    const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    cached = JSON.parse(readFileSync(pkg, 'utf-8')).version;
  } catch {
    cached = 'unknown';
  }
  return cached!;
}

/**
 * 构建来源，由 packages/cli/build.mjs 写成 dist/build-info.json。
 *
 * dist/ 不入版本管理，所以「正在跑的那份产物出自哪次提交」只能靠它自证：
 * 没有它就无法区分「调度在跑最新代码」和「调度在跑几个月前的 bundle」。
 * 读不到时以 missing 标记，绝不臆测提交号。
 */
export interface BuildInfo {
  name?: string;
  version?: string;
  commit?: string;
  commitDate?: string;
  /** true=构建时工作区有未提交改动；false=干净；null=无法判断。 */
  dirty?: boolean | null;
  builtAt?: string;
  /** true 表示缺少 dist/build-info.json（例如从源码直接跑，或产物过旧）。 */
  missing?: boolean;
}

let cachedBuildInfo: BuildInfo | undefined;

export function getBuildInfo(): BuildInfo {
  if (cachedBuildInfo !== undefined) return cachedBuildInfo;
  try {
    const file = resolve(dirname(fileURLToPath(import.meta.url)), 'build-info.json');
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as BuildInfo;
    cachedBuildInfo = parsed && typeof parsed === 'object' ? parsed : { missing: true };
  } catch {
    cachedBuildInfo = { missing: true };
  }
  return cachedBuildInfo;
}

/** 单行摘要，便于 doctor 与定时脚本写日志。 */
export function formatBuildInfo(info: BuildInfo = getBuildInfo()): string {
  if (info.missing) return 'unknown (dist/build-info.json not found)';
  const commit = info.commit && info.commit !== 'unknown' ? info.commit.slice(0, 12) : 'unknown';
  const dirty = info.dirty === true ? '+dirty' : info.dirty === false ? '' : ' (clean state unknown)';
  return `${info.version ?? 'unknown'} @ ${commit}${dirty} built ${info.builtAt ?? 'unknown'}`;
}
