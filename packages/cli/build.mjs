import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * 把构建来源写进 dist/build-info.json，让运行期能自证「这个 bundle 出自哪次提交」。
 *
 * 背景：dist/ 不进版本管理，而每日定时采集只跑已构建产物。若产物只有版本号、没有提交信息，
 * 就无法判断调度到底在跑哪份代码，「只更新了本地产物、调度仍在跑旧版本」会一直不可观测。
 * 因此这里记录 commit / commitDate / dirty / builtAt，由 `aiusage doctor` 与
 * dist/daily-sync.js 打印出来。
 *
 * git 不可用时（例如从 tarball 构建）降级为 'unknown'，不阻断构建。
 */
function readGit(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const porcelain = readGit(['status', '--porcelain']);

const buildInfo = {
  name: pkg.name,
  version: pkg.version,
  commit: readGit(['rev-parse', 'HEAD']) ?? 'unknown',
  commitDate: readGit(['show', '-s', '--format=%cI', 'HEAD']) ?? 'unknown',
  // null 表示无法判断（git 不可用），而不是「干净」。
  dirty: porcelain === undefined ? null : porcelain.length > 0,
  builtAt: new Date().toISOString(),
};

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  external: ['ws'],
  minifySyntax: true,
  treeShaking: true,
  banner: { js: '#!/usr/bin/env node' },
};

// 主 CLI：功能入口。
await build({
  ...shared,
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
});

// 免构建的每日采集入口：只依赖 Node 内置模块，不 import 任何运行时依赖，
// 以便调度器在不安装 node_modules、不执行 pnpm 的情况下直接运行。
await build({
  ...shared,
  external: [],
  entryPoints: ['src/daily-sync.ts'],
  outfile: 'dist/daily-sync.js',
});

mkdirSync('dist', { recursive: true });
writeFileSync('dist/build-info.json', `${JSON.stringify(buildInfo, null, 2)}\n`, 'utf8');
