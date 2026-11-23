import { createHash } from 'node:crypto';
import type { DatabaseBreakdownRow, DatabaseDailyRow } from './recalculate.js';

export interface CostRecalculationBackup {
  schema: 'aiusage-cost-backup-v1';
  createdAt: string;
  database: 'aiusage-db';
  pricingVersion: string;
  tokenFactsSha256: string;
  dateRange: { from?: string; to?: string };
  breakdowns: Array<Pick<DatabaseBreakdownRow,
    'device_id' | 'usage_date' | 'provider' | 'product' | 'channel' | 'model' | 'project'
    | 'estimated_cost_usd' | 'cost_status' | 'cost_source' | 'pricing_version'
    | 'prior_estimated_cost_usd' | 'prior_cost_status' | 'prior_cost_source' | 'prior_pricing_version'>>;
  // Original financial basis is captured on the first recalculation and kept
  // across subsequent repricing runs until an explicit rollback.
  daily: Array<Pick<DatabaseDailyRow,
    'device_id' | 'usage_date' | 'estimated_cost_usd' | 'cost_status' | 'cost_source' | 'pricing_version'
    | 'top_project_by_cost' | 'top_project_cost_usd' | 'top_model_by_cost' | 'top_model_cost_usd'
    | 'prior_estimated_cost_usd' | 'prior_cost_status' | 'prior_cost_source' | 'prior_pricing_version'>>;
  sha256: string;
}

type UnsignedBackup = Omit<CostRecalculationBackup, 'sha256'>;

export function createCostRecalculationBackup(
  breakdownRows: DatabaseBreakdownRow[],
  dailyRows: DatabaseDailyRow[],
  args: { pricingVersion: string; tokenFactsSha256: string; createdAt: string; from?: string; to?: string },
): CostRecalculationBackup {
  const unsigned: UnsignedBackup = {
    schema: 'aiusage-cost-backup-v1',
    createdAt: args.createdAt,
    database: 'aiusage-db',
    pricingVersion: args.pricingVersion,
    tokenFactsSha256: args.tokenFactsSha256,
    dateRange: { from: args.from, to: args.to },
    breakdowns: breakdownRows.map(({ device_id, usage_date, provider, product, channel, model, project, estimated_cost_usd, cost_status, cost_source, pricing_version, prior_estimated_cost_usd, prior_cost_status, prior_cost_source, prior_pricing_version }) =>
      ({ device_id, usage_date, provider, product, channel, model, project, estimated_cost_usd, cost_status, cost_source, pricing_version, prior_estimated_cost_usd, prior_cost_status, prior_cost_source, prior_pricing_version })),
    daily: dailyRows.map(({ device_id, usage_date, estimated_cost_usd, cost_status, cost_source, pricing_version, top_project_by_cost, top_project_cost_usd, top_model_by_cost, top_model_cost_usd, prior_estimated_cost_usd, prior_cost_status, prior_cost_source, prior_pricing_version }) =>
      ({ device_id, usage_date, estimated_cost_usd, cost_status, cost_source, pricing_version, top_project_by_cost, top_project_cost_usd, top_model_by_cost, top_model_cost_usd, prior_estimated_cost_usd, prior_cost_status, prior_cost_source, prior_pricing_version })),
  };
  return { ...unsigned, sha256: digest(unsigned) };
}

export function validateCostRecalculationBackup(value: unknown): CostRecalculationBackup {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('备份格式无效');
  const backup = value as CostRecalculationBackup;
  const { sha256, ...unsigned } = backup;
  if (backup.schema !== 'aiusage-cost-backup-v1' || typeof sha256 !== 'string'
    || digest(unsigned) !== sha256) throw new Error('备份格式无效或 SHA-256 校验失败');
  if (backup.database !== 'aiusage-db' || typeof backup.tokenFactsSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(backup.tokenFactsSha256)
    || !Array.isArray(backup.breakdowns) || !Array.isArray(backup.daily)) {
    throw new Error('备份数据库名称或数据格式无效');
  }
  return backup;
}

export function buildRollbackSqlBatch(backup: CostRecalculationBackup, usageDate: string): string {
  const statements = [
    ...backup.breakdowns.filter(row => row.usage_date === usageDate).map(row => `UPDATE daily_usage_breakdown
SET estimated_cost_usd = ${sqlNumber(row.estimated_cost_usd)}, cost_status = ${sqlString(row.cost_status)}, cost_source = ${sqlString(row.cost_source)}, pricing_version = ${sqlString(row.pricing_version)}, prior_estimated_cost_usd = ${sqlNullableNumber(row.prior_estimated_cost_usd)}, prior_cost_status = ${sqlString(row.prior_cost_status)}, prior_cost_source = ${sqlString(row.prior_cost_source)}, prior_pricing_version = ${sqlString(row.prior_pricing_version)}
WHERE device_id = ${sqlString(row.device_id)} AND usage_date = ${sqlString(row.usage_date)} AND provider = ${sqlString(row.provider)} AND product = ${sqlString(row.product)} AND channel = ${sqlString(row.channel)} AND model = ${sqlString(row.model)} AND project = ${sqlString(row.project)};`),
    ...backup.daily.filter(row => row.usage_date === usageDate).map(row => `UPDATE daily_usage
SET estimated_cost_usd = ${sqlNumber(row.estimated_cost_usd)}, cost_status = ${sqlString(row.cost_status)}, cost_source = ${sqlString(row.cost_source)}, pricing_version = ${sqlString(row.pricing_version)}, prior_estimated_cost_usd = ${sqlNullableNumber(row.prior_estimated_cost_usd)}, prior_cost_status = ${sqlString(row.prior_cost_status)}, prior_cost_source = ${sqlString(row.prior_cost_source)}, prior_pricing_version = ${sqlString(row.prior_pricing_version)}, top_project_by_cost = ${sqlString(row.top_project_by_cost)}, top_project_cost_usd = ${sqlNullableNumber(row.top_project_cost_usd)}, top_model_by_cost = ${sqlString(row.top_model_by_cost)}, top_model_cost_usd = ${sqlNullableNumber(row.top_model_cost_usd)}
WHERE device_id = ${sqlString(row.device_id)} AND usage_date = ${sqlString(row.usage_date)};`),
  ];
  return statements.join('\n');
}

export function verifyRestoredBackup(
  backup: CostRecalculationBackup,
  breakdowns: DatabaseBreakdownRow[],
  daily: DatabaseDailyRow[],
): boolean {
  const breakdownKey = (row: { device_id: string; usage_date: string; provider: string; product: string; channel: string; model: string; project: string }) =>
    [row.device_id, row.usage_date, row.provider, row.product, row.channel, row.model, row.project].join('\0');
  const currentBreakdowns = new Map(breakdowns.map(row => [breakdownKey(row), row]));
  for (const expected of backup.breakdowns) {
    const actual = currentBreakdowns.get(breakdownKey(expected));
    if (!actual || actual.estimated_cost_usd !== expected.estimated_cost_usd
      || actual.cost_status !== expected.cost_status || actual.cost_source !== expected.cost_source
      || actual.pricing_version !== expected.pricing_version
      || actual.prior_estimated_cost_usd !== expected.prior_estimated_cost_usd
      || actual.prior_cost_status !== expected.prior_cost_status || actual.prior_cost_source !== expected.prior_cost_source
      || actual.prior_pricing_version !== expected.prior_pricing_version) return false;
  }
  const currentDaily = new Map(daily.map(row => [`${row.device_id}\0${row.usage_date}`, row]));
  for (const expected of backup.daily) {
    const actual = currentDaily.get(`${expected.device_id}\0${expected.usage_date}`);
    if (!actual || actual.estimated_cost_usd !== expected.estimated_cost_usd
      || actual.cost_status !== expected.cost_status || actual.cost_source !== expected.cost_source
      || actual.pricing_version !== expected.pricing_version
      || actual.prior_estimated_cost_usd !== expected.prior_estimated_cost_usd
      || actual.prior_cost_status !== expected.prior_cost_status || actual.prior_cost_source !== expected.prior_cost_source
      || actual.prior_pricing_version !== expected.prior_pricing_version
      || actual.top_project_by_cost !== expected.top_project_by_cost
      || actual.top_project_cost_usd !== expected.top_project_cost_usd
      || actual.top_model_by_cost !== expected.top_model_by_cost
      || actual.top_model_cost_usd !== expected.top_model_cost_usd) return false;
  }
  return true;
}

export function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function digest(value: unknown): string {
  return sha256Text(JSON.stringify(value));
}

function sqlString(value: string | null): string {
  return value == null ? 'NULL' : `'${value.replaceAll("'", "''")}'`;
}

function sqlNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error('备份金额无效');
  return String(value);
}

function sqlNullableNumber(value: number | null): string {
  return value == null ? 'NULL' : sqlNumber(value);
}
