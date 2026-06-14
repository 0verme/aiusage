import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyDashboardAssets } from './prepare-dashboard-assets.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workerDir = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(workerDir, '..', '..');
const dashboardDistDir = path.resolve(workerDir, '../dashboard/dist');
const workerPublicDir = path.resolve(workerDir, 'public');

function run(command, args, cwd) {
  const isWindowsPnpm = process.platform === 'win32' && command === 'pnpm';
  const bin = isWindowsPnpm ? 'pnpm.cmd' : command;
  const result = spawnSync(bin, args, {
    cwd,
    stdio: 'inherit',
    shell: isWindowsPnpm,
  });
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function ensureDashboardDist() {
  try {
    await fs.access(path.join(dashboardDistDir, 'index.html'));
  } catch {
    run('pnpm', ['--filter', '@aiusage/dashboard', 'build'], repoRoot);
  }
}

await ensureDashboardDist();
run('pnpm', ['exec', 'tsc', '--noEmit'], workerDir);
await copyDashboardAssets({ dashboardDistDir, workerPublicDir });
