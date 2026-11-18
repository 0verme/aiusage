import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { getPricingCatalog } from '@aiusage/shared';
import {
  buildCompatibleSelect,
  buildRecalculationPlan,
  buildSqlBatch,
  snapshotTokenFacts,
  type CompatibleColumn,
  type DatabaseBreakdownRow,
  type DatabaseDailyRow,
  type RecalculationScope,
} from '../src/maintenance/recalculate.js';
import {
  buildRollbackSqlBatch,
  createCostRecalculationBackup,
  sha256Text,
  validateCostRecalculationBackup,
  verifyRestoredBackup,
  type CostRecalculationBackup,
} from '../src/maintenance/cost-backup.js';

const execFileAsync = promisify(execFile);
const workerDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpmBin = 'corepack';
const wranglerScript = resolve(workerDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

interface Options {
  remote: boolean;
  apply: boolean;
  yes: boolean;
  from?: string;
  to?: string;
  backupDir?: string;
  rollbackFile?: string;
  scope: RecalculationScope;
}

interface D1Envelope<T> {
  results?: T[];
}

const BREAKDOWN_COLUMNS: CompatibleColumn[] = [
  'device_id', 'usage_date', 'provider', 'product', 'channel', 'model', 'project',
  'project_display', 'project_alias', 'event_count', 'session_count', 'input_tokens',
  'cached_input_tokens', 'cache_write_tokens', 'output_tokens', 'reasoning_output_tokens',
  'estimated_cost_usd', 'cost_status', 'pricing_version', 'extra_metrics_json',
  { name: 'cost_source', fallbackSql: "'legacy_unknown'" },
  { name: 'reported_cost_usd', fallbackSql: 'NULL' },
  { name: 'reported_cost_source', fallbackSql: 'NULL' },
  { name: 'output_tokens_includes_reasoning', fallbackSql: 'NULL' },
  { name: 'prior_estimated_cost_usd', fallbackSql: 'NULL' },
  { name: 'prior_cost_status', fallbackSql: 'NULL' },
  { name: 'prior_cost_source', fallbackSql: 'NULL' },
  { name: 'prior_pricing_version', fallbackSql: 'NULL' },
];

const DAILY_COLUMNS: CompatibleColumn[] = [
  'device_id', 'usage_date', 'event_count', 'input_tokens', 'cached_input_tokens',
  'cache_write_tokens', 'output_tokens', 'reasoning_output_tokens', 'estimated_cost_usd',
  'cost_status', 'pricing_version',
  { name: 'cost_source', fallbackSql: "'legacy_unknown'" },
  { name: 'top_project_by_cost', fallbackSql: "'unknown'" },
  { name: 'top_project_cost_usd', fallbackSql: '0' },
  { name: 'top_model_by_cost', fallbackSql: "'unknown'" },
  { name: 'top_model_cost_usd', fallbackSql: '0' },
  { name: 'prior_estimated_cost_usd', fallbackSql: 'NULL' },
  { name: 'prior_cost_status', fallbackSql: 'NULL' },
  { name: 'prior_cost_source', fallbackSql: 'NULL' },
  { name: 'prior_pricing_version', fallbackSql: 'NULL' },
];

const REQUIRED_RECALC_COLUMNS = {
  daily_usage_breakdown: [
    'cost_source', 'reported_cost_usd', 'reported_cost_source', 'output_tokens_includes_reasoning',
    'prior_estimated_cost_usd', 'prior_cost_status', 'prior_cost_source', 'prior_pricing_version',
  ],
  daily_usage: [
    'cost_source', 'prior_estimated_cost_usd', 'prior_cost_status', 'prior_cost_source',
    'prior_pricing_version', 'snapshot_complete',
  ],
} as const;

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
  if (options.rollbackFile) {
    if (options.apply) throw new Error('--rollback 与 --apply 不能同时使用');
    if (!options.yes) throw new Error('回滚需要显式传入 --yes');
    await rollbackFromBackup(options.rollbackFile, options.remote);
    return;
  }

  const [breakdownColumns, dailyColumns] = await Promise.all([
    tableColumns('daily_usage_breakdown', options.remote),
    tableColumns('daily_usage', options.remote),
  ]);
  const fullRecalculationSchema = hasFullRecalculationSchema(breakdownColumns, dailyColumns);
  if (options.apply && !fullRecalculationSchema) {
    throw new Error('生产 apply 要求先完成 0006-0008 数据库迁移；旧结构仅支持只读 dry-run。');
  }
  const [breakdownRows, dailyRows] = await Promise.all([
    queryRows<DatabaseBreakdownRow>(buildCompatibleSelect(
      'daily_usage_breakdown', breakdownColumns, BREAKDOWN_COLUMNS,
      `${dateWhere(options.from, options.to)} ORDER BY usage_date, device_id, provider, product, model, project`,
    ), options.remote),
    queryRows<DatabaseDailyRow>(buildCompatibleSelect(
      'daily_usage', dailyColumns, DAILY_COLUMNS,
      `${dateWhere(options.from, options.to)} ORDER BY usage_date, device_id`,
    ), options.remote),
  ]);
  const catalog = getPricingCatalog();
  const plan = buildRecalculationPlan(breakdownRows, dailyRows, {
    catalog,
    from: options.from,
    to: options.to,
    scope: options.scope,
  });

  let backupPath: string | undefined;
  let databaseBackupPath: string | undefined;
  let appliedBatches = 0;
  let tokenFactsUnchanged: 'YES' | 'NOT_CHECKED' = 'NOT_CHECKED';
  let finalSummary = plan.summary;

  if (options.apply) {
    const changedBreakdowns = plan.breakdowns.filter(update => update.changed);
    const changedDaily = plan.daily.filter(update => update.changed);
    const dates = [...new Set([
      ...changedBreakdowns.map(update => update.row.usage_date),
      ...changedDaily.map(update => update.row.usage_date),
    ])].sort();
    if (dates.length === 0) throw new Error('指定范围没有费用变化，无需 apply。');
    const affectedDates = new Set(dates);
    const affectedBreakdowns = breakdownRows.filter(row => affectedDates.has(row.usage_date));
    const affectedDaily = dailyRows.filter(row => affectedDates.has(row.usage_date));
    const backup = await exportBackup(
      options,
      changedBreakdowns.map(update => update.row),
      changedDaily.map(update => update.row),
      catalog.version,
      affectedBreakdowns,
      affectedDaily,
    );
    backupPath = backup.costJson;
    databaseBackupPath = backup.fullSql;
    const updatedAt = new Date().toISOString();

    for (const usageDate of dates) {
      const sql = buildSqlBatch(plan, usageDate, updatedAt);
      if (!sql) continue;
      for (const chunk of chunkSql(sql, 100)) {
        await executeSql(chunk, options.remote);
        appliedBatches += 1;
      }
    }

    const [afterBreakdowns, afterDaily] = await Promise.all([
      queryRows<DatabaseBreakdownRow>(buildCompatibleSelect(
        'daily_usage_breakdown', breakdownColumns, BREAKDOWN_COLUMNS,
        `${dateWhere(options.from, options.to)} ORDER BY usage_date, device_id, provider, product, model, project`,
      ), options.remote),
      queryRows<DatabaseDailyRow>(buildCompatibleSelect(
        'daily_usage', dailyColumns, DAILY_COLUMNS,
        `${dateWhere(options.from, options.to)} ORDER BY usage_date, device_id`,
      ), options.remote),
    ]);
    tokenFactsUnchanged = snapshotTokenFacts(breakdownRows, dailyRows) === snapshotTokenFacts(afterBreakdowns, afterDaily)
      ? 'YES'
      : 'NOT_CHECKED';
    if (tokenFactsUnchanged !== 'YES') {
      console.log(JSON.stringify({
        mode: 'apply',
        pricingVersion: catalog.version,
        backupPath,
        databaseBackupPath,
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
      scope: options.scope,
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
      scopedCostChanges: plan.summary.scopedCostChanges,
    };
  }

  console.log(JSON.stringify({
    mode: options.apply ? 'apply' : 'dry-run',
    database: 'aiusage-db',
    pricingVersion: catalog.version,
    dataSchema: fullRecalculationSchema ? 'provenance-enabled' : 'legacy-read-only-compatibility',
    scope: options.scope,
    semantics: 'Current Catalog Revaluation',
    backupPath: backupPath ?? null,
    databaseBackupPath: databaseBackupPath ?? null,
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
    scope: { deviceIds: [], products: [], models: [], rawProviders: [] },
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') continue;
    if (arg === '--remote') options.remote = true;
    else if (arg === '--local') options.remote = false;
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--yes') options.yes = true;
    else if (arg === '--dry-run') options.apply = false;
    else if (arg === '--from') options.from = readDateArg(args[++index], '--from');
    else if (arg === '--to') options.to = readDateArg(args[++index], '--to');
    else if (arg === '--device') options.scope.deviceIds!.push(readNonEmptyArg(args[++index], '--device'));
    else if (arg === '--product') options.scope.products!.push(readNonEmptyArg(args[++index], '--product'));
    else if (arg === '--model') options.scope.models!.push(readNonEmptyArg(args[++index], '--model'));
    else if (arg === '--raw-provider') options.scope.rawProviders!.push(readNonEmptyArg(args[++index], '--raw-provider'));
    else if (arg === '--backup-dir') options.backupDir = args[++index];
    else if (arg === '--rollback') {
      const path = args[++index];
      if (!path) throw new Error('--rollback 需要一个备份 JSON 路径');
      options.rollbackFile = path;
    }
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  if (options.to && !options.from) throw new Error('--to 需要搭配 --from');
  const scoped = Boolean(options.scope.deviceIds?.length || options.scope.products?.length
    || options.scope.models?.length || options.scope.rawProviders?.length);
  if (scoped && (!options.from || !options.to)) throw new Error('指定设备、产品或模型时必须同时提供 --from 和 --to');
  return options;
}

async function queryRows<T>(sql: string, remote: boolean): Promise<T[]> {
  const payload = await executeJson<D1Envelope<T>>(sql, remote);
  return payload.results ?? [];
}

async function tableColumns(table: 'daily_usage' | 'daily_usage_breakdown', remote: boolean): Promise<Set<string>> {
  const payload = await executeJson<D1Envelope<{ name: string }>>(`PRAGMA table_info(${table})`, remote);
  const columns = new Set((payload.results ?? []).map(row => row.name));
  if (columns.size === 0) throw new Error(`无法读取 ${table} 的 D1 schema`);
  return columns;
}

function hasFullRecalculationSchema(breakdownColumns: ReadonlySet<string>, dailyColumns: ReadonlySet<string>): boolean {
  return Object.entries(REQUIRED_RECALC_COLUMNS).every(([table, required]) => {
    const columns = table === 'daily_usage_breakdown' ? breakdownColumns : dailyColumns;
    return required.every(column => columns.has(column));
  });
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
  const prefix = process.platform === 'win32' ? [wranglerScript] : ['pnpm', 'exec', 'wrangler'];
  const result = await execFileAsync(command, [...prefix, ...args], {
    cwd: workerDir,
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function exportBackup(
  options: Options,
  breakdownRows: DatabaseBreakdownRow[],
  dailyRows: DatabaseDailyRow[],
  pricingVersion: string,
  tokenFactBreakdowns: DatabaseBreakdownRow[] = breakdownRows,
  tokenFactDaily: DatabaseDailyRow[] = dailyRows,
): Promise<{ costJson: string; fullSql: string }> {
  const stamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, '').slice(0, 17);
  const backupDir = resolve(options.backupDir ?? resolve(workerDir, '../../tmp', `d1-recalculate-${stamp}`));
  await mkdir(backupDir, { recursive: true });
  const fullSql = join(backupDir, 'aiusage-db-full.sql');
  await runWrangler([
    'd1', 'export', 'aiusage-db', options.remote ? '--remote' : '--local', '--output', fullSql,
  ]);
  await chmod(fullSql, 0o600);
  const output = join(backupDir, 'aiusage-cost-backup.json');
  const backup = createCostRecalculationBackup(breakdownRows, dailyRows, {
    pricingVersion,
    tokenFactsSha256: sha256Text(snapshotTokenFacts(tokenFactBreakdowns, tokenFactDaily)),
    createdAt: new Date().toISOString(),
    from: options.from,
    to: options.to,
  });
  await writeFile(output, `${JSON.stringify(backup, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return { costJson: output, fullSql };
}

async function rollbackFromBackup(path: string, remote: boolean): Promise<void> {
  const backup: CostRecalculationBackup = validateCostRecalculationBackup(JSON.parse(await readFile(resolve(path), 'utf8')) as unknown);
  const [breakdownColumns, dailyColumns] = await Promise.all([
    tableColumns('daily_usage_breakdown', remote),
    tableColumns('daily_usage', remote),
  ]);
  if (!hasFullRecalculationSchema(breakdownColumns, dailyColumns)) {
    throw new Error('费用回滚要求先完成 0006-0008 数据库迁移。');
  }
  const dates = [...new Set([
    ...backup.breakdowns.map(row => row.usage_date),
    ...backup.daily.map(row => row.usage_date),
  ])].sort();
  const where = dateListWhere(dates);
  const [beforeBreakdowns, beforeDaily] = await Promise.all([
    queryRows<DatabaseBreakdownRow>(buildCompatibleSelect(
      'daily_usage_breakdown', breakdownColumns, BREAKDOWN_COLUMNS,
      `${where} ORDER BY usage_date, device_id, provider, product, model, project`,
    ), remote),
    queryRows<DatabaseDailyRow>(buildCompatibleSelect(
      'daily_usage', dailyColumns, DAILY_COLUMNS,
      `${where} ORDER BY usage_date, device_id`,
    ), remote),
  ]);
  const beforeFacts = snapshotTokenFacts(beforeBreakdowns, beforeDaily);
  if (sha256Text(beforeFacts) !== backup.tokenFactsSha256) {
    throw new Error('备份后的 token 或源用量事实已变化，拒绝回滚以避免覆盖新数据');
  }
  let appliedBatches = 0;
  for (const usageDate of dates) {
    const statements = buildRollbackSqlBatch(backup, usageDate);
    for (const chunk of chunkSql(statements, 100)) {
      await executeSql(chunk, remote);
      appliedBatches += 1;
    }
  }
  const [afterBreakdowns, afterDaily] = await Promise.all([
    queryRows<DatabaseBreakdownRow>(buildCompatibleSelect(
      'daily_usage_breakdown', breakdownColumns, BREAKDOWN_COLUMNS,
      `${where} ORDER BY usage_date, device_id, provider, product, model, project`,
    ), remote),
    queryRows<DatabaseDailyRow>(buildCompatibleSelect(
      'daily_usage', dailyColumns, DAILY_COLUMNS,
      `${where} ORDER BY usage_date, device_id`,
    ), remote),
  ]);
  const tokenFactsUnchanged = beforeFacts === snapshotTokenFacts(afterBreakdowns, afterDaily);
  const restoredRowsMatch = verifyRestoredBackup(backup, afterBreakdowns, afterDaily);
  console.log(JSON.stringify({ mode: 'rollback', backup: resolve(path), database: 'aiusage-db', appliedBatches, tokenFactsUnchanged, restoredRowsMatch }, null, 2));
  if (!tokenFactsUnchanged || !restoredRowsMatch) throw new Error('回滚后验证失败');
}

function dateListWhere(dates: string[]): string {
  return dates.length === 0 ? ' WHERE 1 = 0' : ` WHERE usage_date IN (${dates.map(sqlString).join(', ')})`;
}

function chunkSql(sql: string, maxStatements: number): string[] {
  const statements = sql.split(/;\s*/).map(value => value.trim()).filter(Boolean);
  const chunks: string[] = [];
  for (let index = 0; index < statements.length; index += maxStatements) {
    chunks.push(`${statements.slice(index, index + maxStatements).join(';\n')};`);
  }
  return chunks;
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

function readNonEmptyArg(value: string | undefined, flag: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${flag} 需要一个非空值`);
  return normalized;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlNumber(value: number | null): string {
  return String(Math.round((Number(value) || 0) * 10000) / 10000);
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
  --device ID              Limit changed rows (repeatable)
  --product PRODUCT        Limit changed rows (repeatable)
  --model MODEL            Limit changed rows by the raw stored model (repeatable)
  --raw-provider PROVIDER  Require one explicit recorded raw route (repeatable)
  --apply --yes            Export backup, apply date batches, and verify token facts
  --backup-dir PATH        Directory for the SHA-256 checked JSON rollback artifact
  --rollback PATH --yes    Restore financial fields from a previous JSON backup
`);
}

await main();
