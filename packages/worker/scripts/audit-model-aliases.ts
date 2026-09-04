import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { auditModelAliases } from '@aiusage/shared';

const execFileAsync = promisify(execFile);
const workerDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpmBin = 'pnpm';
const wranglerScript = resolve(workerDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

interface Options {
  remote: boolean;
  from?: string;
  to?: string;
}

interface ModelRow {
  model: string | null;
  extra_metrics_json: string | null;
}

interface D1Envelope<T> {
  results?: T[];
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const rows = await queryRows<ModelRow>(
    `SELECT model, extra_metrics_json FROM daily_usage_breakdown${dateWhere(options.from, options.to)}`,
    options.remote,
  );
  const rawModels = rows.flatMap(extractRawModels);
  const report = auditModelAliases(rawModels);
  console.log(JSON.stringify({
    database: 'aiusage-db',
    mode: options.remote ? 'remote' : 'local',
    dateRange: { from: options.from ?? null, to: options.to ?? null },
    breakdownRows: rows.length,
    ...report,
  }, null, 2));
}

function parseOptions(args: string[]): Options {
  const options: Options = { remote: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--remote') options.remote = true;
    else if (arg === '--local') options.remote = false;
    else if (arg === '--from') options.from = readDateArg(args[++index], '--from');
    else if (arg === '--to') options.to = readDateArg(args[++index], '--to');
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

function extractRawModels(row: ModelRow): string[] {
  const values = row.model ? [row.model] : [];
  if (!row.extra_metrics_json) return values;
  try {
    const extra: unknown = JSON.parse(row.extra_metrics_json);
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return values;
    const record = extra as Record<string, unknown>;
    if (typeof record.raw_model === 'string') values.push(record.raw_model);
    if (Array.isArray(record.raw_models)) {
      for (const value of record.raw_models) {
        if (typeof value === 'string') values.push(value);
      }
    }
  } catch {
    // Keep the legacy model value when an old row contains malformed metadata.
  }
  return values;
}

async function queryRows<T>(sql: string, remote: boolean): Promise<T[]> {
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
  return (envelope as D1Envelope<T>).results ?? [];
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

function stripWranglerNoise(stdout: string): string {
  const starts = [stdout.indexOf('['), stdout.indexOf('{')].filter(index => index >= 0);
  const start = starts.length > 0 ? Math.min(...starts) : -1;
  if (start < 0) throw new Error('D1 returned no JSON payload');
  return stdout.slice(start).trim();
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

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function printHelp(): void {
  console.log(`Usage: pnpm --filter @aiusage/worker db:audit-models --remote [options]

Read-only model alias audit. It never changes D1 data.
Options:
  --remote                 Read the remote aiusage-db
  --local                  Read the local aiusage-db
  --from YYYY-MM-DD        Inclusive start date
  --to YYYY-MM-DD          Inclusive end date
`);
}

await main();
