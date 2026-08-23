import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { getPricingCatalog } from '@aiusage/shared';
import {
  buildRecalculationPlan,
  buildSqlBatch,
  snapshotTokenFacts,
  type DatabaseBreakdownRow,
  type DatabaseDailyRow,
} from '../src/maintenance/recalculate.js';

const execFileAsync = promisify(execFile);
const workerDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpmBin = 'pnpm';
const wranglerScript = resolve(workerDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

interface Options {
  remote: boolean;
  apply: boolean;
  yes: boolean;
  from?: string;
  to?: string;
  backupDir?: string;
}

interface D1Envelope<T> {
  results?: T[];
}

const BREAKDOWN_SELECT = `
  SELECT device_id, usage_date, provider, product, channel, model, project,
         project_display, project_alias, event_count, session_count,
         input_tokens, cached_input_tokens, cache_write_tokens,
         output_tokens, reasoning_output_tokens, estimated_cost_usd,
         cost_status, pricing_version, extra_metrics_json
  FROM daily_usage_breakdown`;

const DAILY_SELECT = `
  SELECT device_id, usage_date, event_count, input_tokens,
         cached_input_tokens, cache_write_tokens, output_tokens,
         reasoning_output_tokens, estimated_cost_usd, cost_status,
         pricing_version, top_project_by_cost, top_project_cost_usd,
         top_model_by_cost, top_model_cost_usd
  FROM daily_usage`;

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (!options.remote && !hasFlag(process.argv.slice(2), '--local')) {
    throw new Error('必须显式指定 --remote 或 --local；默认只读保护，避免误操作生产 D1。');
  }
  if (options.apply && !options.remote) {
    throw new Error('--apply 只允许配合 --remote 或受控的本地测试库使用。');
  }
  if (options.apply && !options.yes) {
    throw new Error('生产 apply 需要显式传入 --yes；不带 --apply 的默认模式是 dry-run。');
  }

  const [breakdownRows, dailyRows] = await Promise.all([
    queryRows<DatabaseBreakdownRow>(`${BREAKDOWN_SELECT}${dateWhere(options.from, options.to)} ORDER BY usage_date, device_id, provider, product, model, project`, options.remote),
    queryRows<DatabaseDailyRow>(`${DAILY_SELECT}${dateWhere(options.from, options.to)} ORDER BY usage_date, device_id`, options.remote),
  ]);
  const catalog = getPricingCatalog();
  const plan = buildRecalculationPlan(breakdownRows, dailyRows, {
    catalog,
    from: options.from,
    to: options.to,
  });

  let backupPath: string | undefined;
  let appliedBatches = 0;
  let tokenFactsUnchanged: 'YES' | 'NOT_CHECKED' = 'NOT_CHECKED';
  let finalSummary = plan.summary;

  if (options.apply) {
    backupPath = await exportBackup(options);
    const updatedAt = new Date().toISOString();
    const dates = [...new Set([
      ...plan.breakdowns.filter(update => update.changed).map(update => update.row.usage_date),
      ...plan.daily.filter(update => update.changed).map(update => update.row.usage_date),
    ])].sort();

    for (const usageDate of dates) {
      const sql = buildSqlBatch(plan, usageDate, updatedAt);
      if (!sql) continue;
      await executeSql(sql, options.remote);
      appliedBatches += 1;
    }

    const [afterBreakdowns, afterDaily] = await Promise.all([
      queryRows<DatabaseBreakdownRow>(`${BREAKDOWN_SELECT}${dateWhere(options.from, options.to)} ORDER BY usage_date, device_id, provider, product, model, project`, options.remote),
      queryRows<DatabaseDailyRow>(`${DAILY_SELECT}${dateWhere(options.from, options.to)} ORDER BY usage_date, device_id`, options.remote),
    ]);
    tokenFactsUnchanged = snapshotTokenFacts(breakdownRows, dailyRows) === snapshotTokenFacts(afterBreakdowns, afterDaily)
      ? 'YES'
      : 'NOT_CHECKED';
    if (tokenFactsUnchanged !== 'YES') {
      console.log(JSON.stringify({
        mode: 'apply',
        pricingVersion: catalog.version,
        backupPath,
        appliedBatches,
        tokenFactsUnchanged: 'NO',
        summary: plan.summary,
      }, null, 2));
      throw new Error('TOKEN_FACTS_UNCHANGED: NO');
    }

    const appliedPlan = buildRecalculationPlan(afterBreakdowns, afterDaily, {
      catalog,
      from: options.from,
      to: options.to,
    });
    finalSummary = {
      ...plan.summary,
      after: appliedPlan.summary.before,
      costDeltaUsd: roundUsd(appliedPlan.summary.before.totalCostUsd - plan.summary.before.totalCostUsd),
      costDeltaPercent: plan.summary.before.totalCostUsd === 0
        ? (appliedPlan.summary.before.totalCostUsd === 0 ? 0 : null)
        : roundUsd(((appliedPlan.summary.before.totalCostUsd - plan.summary.before.totalCostUsd) / plan.summary.before.totalCostUsd) * 100),
      unavailableRowsAfter: appliedPlan.summary.unavailableRowsAfter,
      modelsStillUnavailable: appliedPlan.summary.modelsStillUnavailable,
      modelCostChanges: plan.summary.modelCostChanges,
    };
  }

  console.log(JSON.stringify({
    mode: options.apply ? 'apply' : 'dry-run',
    database: 'aiusage-db',
    pricingVersion: catalog.version,
    semantics: 'Current Catalog Revaluation',
    backupPath: backupPath ?? null,
    appliedBatches,
    tokenFactsUnchanged,
    summary: finalSummary,
  }, null, 2));
}

function parseOptions(args: string[]): Options {
  const options: Options = {
    remote: false,
    apply: false,
    yes: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--remote') options.remote = true;
    else if (arg === '--local') options.remote = false;
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--yes') options.yes = true;
    else if (arg === '--dry-run') options.apply = false;
    else if (arg === '--from') options.from = readDateArg(args[++index], '--from');
    else if (arg === '--to') options.to = readDateArg(args[++index], '--to');
    else if (arg === '--backup-dir') options.backupDir = args[++index];
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  if (options.to && !options.from) throw new Error('--to 需要搭配 --from');
  return options;
}

async function queryRows<T>(sql: string, remote: boolean): Promise<T[]> {
  const payload = await executeJson<D1Envelope<T>>(sql, remote);
  return payload.results ?? [];
}

async function executeJson<T>(sql: string, remote: boolean): Promise<T> {
  const stdout = await runWrangler([
    'd1',
    'execute',
    'aiusage-db',
    remote ? '--remote' : '--local',
    '--command',
    sql,
    '--json',
  ]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripWranglerNoise(stdout)) as unknown;
  } catch (error) {
    throw new Error(`D1 returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const envelope = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!envelope || typeof envelope !== 'object') throw new Error('D1 returned an invalid JSON envelope');
  return envelope as T;
}

function stripWranglerNoise(stdout: string): string {
  const starts = [stdout.indexOf('['), stdout.indexOf('{')].filter(index => index >= 0);
  const start = starts.length > 0 ? Math.min(...starts) : -1;
  if (start < 0) throw new Error('D1 returned no JSON payload');
  return stdout.slice(start).trim();
}

async function executeSql(sql: string, remote: boolean): Promise<void> {
  await runWrangler([
    'd1',
    'execute',
    'aiusage-db',
    remote ? '--remote' : '--local',
    '--command',
    sql,
    '--json',
  ]);
}

async function runWrangler(args: string[]): Promise<string> {
  const command = process.platform === 'win32' ? process.execPath : pnpmBin;
  const prefix = process.platform === 'win32' ? [wranglerScript] : ['exec', 'wrangler'];
  const result = await execFileAsync(command, [...prefix, ...args], {
    cwd: workerDir,
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function exportBackup(options: Options): Promise<string> {
  const stamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, '').slice(0, 14);
  const backupDir = resolve(options.backupDir ?? resolve(workerDir, '../../tmp', `d1-recalculate-${stamp}`));
  await mkdir(backupDir, { recursive: true });
  const output = join(backupDir, 'aiusage-db-daily-usage-and-breakdown.sql');
  await runWrangler([
    'd1',
    'export',
    'aiusage-db',
    options.remote ? '--remote' : '--local',
    '--table',
    'daily_usage',
    '--table',
    'daily_usage_breakdown',
    '--no-schema',
    '--output',
    output,
  ]);
  return output;
}

function dateWhere(from?: string, to?: string): string {
  const clauses: string[] = [];
  if (from) clauses.push(`usage_date >= ${sqlString(from)}`);
  if (to) clauses.push(`usage_date <= ${sqlString(to)}`);
  return clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
}

function readDateArg(value: string | undefined, flag: string): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${flag} 必须是 YYYY-MM-DD`);
  return value;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function roundUsd(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function printHelp(): void {
  console.log(`Usage: node --import tsx/esm scripts/recalculate-costs.ts --remote [options]

Default mode is dry-run. Production apply requires both --apply and --yes.
Options:
  --remote                 Use the remote aiusage-db (required for production apply)
  --local                  Use the local aiusage-db
  --from YYYY-MM-DD        Inclusive start date
  --to YYYY-MM-DD          Inclusive end date
  --apply --yes            Export backup, apply date batches, and verify token facts
  --backup-dir PATH        Directory for the rollback SQL artifact
`);
}

await main();
