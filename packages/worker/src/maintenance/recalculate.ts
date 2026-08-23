import {
  calculateCost,
  getPricingCatalog,
  getWorstCostStatus,
  type CostStatus,
  type PricingCatalog,
} from '@aiusage/shared';

export interface DatabaseBreakdownRow {
  device_id: string;
  usage_date: string;
  provider: string;
  product: string;
  channel: string;
  model: string;
  project: string;
  project_display: string | null;
  project_alias: string | null;
  event_count: number;
  session_count: number;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  estimated_cost_usd: number;
  cost_status: CostStatus;
  pricing_version: string | null;
  extra_metrics_json: string | null;
}

export interface DatabaseDailyRow {
  device_id: string;
  usage_date: string;
  event_count: number;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  estimated_cost_usd: number;
  cost_status: CostStatus;
  pricing_version: string | null;
  top_project_by_cost: string | null;
  top_project_cost_usd: number | null;
  top_model_by_cost: string | null;
  top_model_cost_usd: number | null;
}

export interface BreakdownUpdate {
  row: DatabaseBreakdownRow;
  estimatedCostUsd: number;
  costStatus: CostStatus;
  pricingVersion: string;
  changed: boolean;
}

export interface DailyUpdate {
  row: DatabaseDailyRow;
  estimatedCostUsd: number;
  costStatus: CostStatus;
  pricingVersion: string;
  topProject: string;
  topProjectCostUsd: number;
  topModel: string;
  topModelCostUsd: number;
  changed: boolean;
}

export interface CostTotals {
  totalEvents: number;
  totalTokens: number;
  totalCostUsd: number;
  costBearingEvents: number;
}

export interface UnavailableModelSummary {
  provider: string;
  product: string;
  model: string;
  rows: number;
  totalTokens: number;
}

export interface ModelCostChange {
  provider: string;
  product: string;
  model: string;
  rows: number;
  totalTokens: number;
  beforeCostUsd: number;
  afterCostUsd: number;
  beforeStatus: CostStatus;
  afterStatus: CostStatus;
}

export interface RecalculationSummary {
  dateRange: { from?: string; to?: string };
  rowsScanned: number;
  rowsChanged: number;
  dailyRowsScanned: number;
  dailyRowsChanged: number;
  before: CostTotals;
  after: CostTotals;
  costDeltaUsd: number;
  costDeltaPercent: number | null;
  unavailableRowsBefore: number;
  unavailableRowsAfter: number;
  modelsStillUnavailable: UnavailableModelSummary[];
  modelCostChanges: ModelCostChange[];
}

export interface RecalculationPlan {
  breakdowns: BreakdownUpdate[];
  daily: DailyUpdate[];
  summary: RecalculationSummary;
}

interface DayAggregate {
  totalCostUsd: number;
  statuses: CostStatus[];
  projects: Map<string, number>;
  models: Map<string, number>;
}

const TOKEN_COLUMNS = [
  'event_count',
  'session_count',
  'input_tokens',
  'cached_input_tokens',
  'cache_write_tokens',
  'output_tokens',
  'reasoning_output_tokens',
] as const;

export function buildRecalculationPlan(
  breakdownRows: DatabaseBreakdownRow[],
  dailyRows: DatabaseDailyRow[],
  options: {
    catalog?: PricingCatalog;
    from?: string;
    to?: string;
  } = {},
): RecalculationPlan {
  const catalog = options.catalog ?? getPricingCatalog();
  const breakdowns = breakdownRows.map(row => calculateBreakdownUpdate(row, catalog));
  const aggregates = new Map<string, DayAggregate>();

  for (const update of breakdowns) {
    const key = dailyKey(update.row.device_id, update.row.usage_date);
    let aggregate = aggregates.get(key);
    if (!aggregate) {
      aggregate = {
        totalCostUsd: 0,
        statuses: [],
        projects: new Map(),
        models: new Map(),
      };
      aggregates.set(key, aggregate);
    }
    aggregate.totalCostUsd += update.estimatedCostUsd;
    aggregate.statuses.push(update.costStatus);
    addCost(aggregate.projects, publicProjectLabel(update.row), update.estimatedCostUsd);
    addCost(aggregate.models, update.row.model || 'unknown', update.estimatedCostUsd);
  }

  const daily = dailyRows.map(row => buildDailyUpdate(row, aggregates.get(dailyKey(row.device_id, row.usage_date)), catalog.version));
  const before = summarizeBreakdowns(breakdownRows);
  const after = summarizeBreakdowns(breakdowns.map(update => ({
    ...update.row,
    estimated_cost_usd: update.estimatedCostUsd,
    cost_status: update.costStatus,
  })));
  const costDeltaUsd = roundUsd(after.totalCostUsd - before.totalCostUsd);

  return {
    breakdowns,
    daily,
    summary: {
      dateRange: { from: options.from, to: options.to },
      rowsScanned: breakdownRows.length,
      rowsChanged: breakdowns.filter(update => update.changed).length,
      dailyRowsScanned: dailyRows.length,
      dailyRowsChanged: daily.filter(update => update.changed).length,
      before,
      after,
      costDeltaUsd,
      costDeltaPercent: before.totalCostUsd === 0
        ? (after.totalCostUsd === 0 ? 0 : null)
        : roundUsd((costDeltaUsd / before.totalCostUsd) * 100),
      unavailableRowsBefore: breakdownRows.filter(row => row.cost_status === 'unavailable').length,
      unavailableRowsAfter: breakdowns.filter(update => update.costStatus === 'unavailable').length,
      modelsStillUnavailable: summarizeUnavailable(breakdowns),
      modelCostChanges: summarizeModelCostChanges(breakdownRows, breakdowns),
    },
  };
}

function calculateBreakdownUpdate(row: DatabaseBreakdownRow, catalog: PricingCatalog): BreakdownUpdate {
  const existingVendorCost = isVendorReportedProduct(row.product) && Number(row.estimated_cost_usd) > 0;
  const result = existingVendorCost
    ? {
      estimatedCostUsd: Number(row.estimated_cost_usd),
      costStatus: 'exact' as const,
    }
    : calculateCost(
      row.provider,
      row.product,
      row.model,
      {
        inputTokens: number(row.input_tokens),
        cachedInputTokens: number(row.cached_input_tokens),
        cacheWriteTokens: number(row.cache_write_tokens),
        cacheWrite5mTokens: cacheWriteTokens(row, 'cache_write_5m_tokens'),
        cacheWrite1hTokens: cacheWriteTokens(row, 'cache_write_1h_tokens'),
        outputTokens: number(row.output_tokens),
        reasoningOutputTokens: number(row.reasoning_output_tokens),
      },
      { requestCount: number(row.event_count), catalog },
    );

  const estimatedCostUsd = roundUsd(result.estimatedCostUsd);
  return {
    row,
    estimatedCostUsd,
    costStatus: result.costStatus,
    pricingVersion: catalog.version,
    changed: estimatedCostUsd !== roundUsd(row.estimated_cost_usd)
      || result.costStatus !== row.cost_status
      || catalog.version !== (row.pricing_version ?? ''),
  };
}

function buildDailyUpdate(
  row: DatabaseDailyRow,
  aggregate: DayAggregate | undefined,
  pricingVersion: string,
): DailyUpdate {
  const totalCostUsd = roundUsd(aggregate?.totalCostUsd ?? 0);
  const costStatus = aggregate ? getWorstCostStatus(aggregate.statuses) : 'exact';
  const topProject = topEntry(aggregate?.projects) ?? { name: 'unknown', cost: 0 };
  const topModel = topEntry(aggregate?.models) ?? { name: 'unknown', cost: 0 };
  const topProjectCostUsd = roundUsd(topProject.cost);
  const topModelCostUsd = roundUsd(topModel.cost);

  return {
    row,
    estimatedCostUsd: totalCostUsd,
    costStatus,
    pricingVersion,
    topProject: topProject.name,
    topProjectCostUsd,
    topModel: topModel.name,
    topModelCostUsd,
    changed: totalCostUsd !== roundUsd(row.estimated_cost_usd)
      || costStatus !== row.cost_status
      || pricingVersion !== (row.pricing_version ?? '')
      || topProject.name !== (row.top_project_by_cost ?? 'unknown')
      || topProjectCostUsd !== roundUsd(row.top_project_cost_usd ?? 0)
      || topModel.name !== (row.top_model_by_cost ?? 'unknown')
      || topModelCostUsd !== roundUsd(row.top_model_cost_usd ?? 0),
  };
}

export function buildSqlBatch(
  plan: RecalculationPlan,
  usageDate: string,
  updatedAt: string,
): string {
  const statements = [
    ...plan.breakdowns
      .filter(update => update.changed && update.row.usage_date === usageDate)
      .map(update => `UPDATE daily_usage_breakdown
SET estimated_cost_usd = ${sqlNumber(update.estimatedCostUsd)}, cost_status = ${sqlString(update.costStatus)}, pricing_version = ${sqlString(update.pricingVersion)}, updated_at = ${sqlString(updatedAt)}
WHERE device_id = ${sqlString(update.row.device_id)} AND usage_date = ${sqlString(update.row.usage_date)} AND provider = ${sqlString(update.row.provider)} AND product = ${sqlString(update.row.product)} AND channel = ${sqlString(update.row.channel)} AND model = ${sqlString(update.row.model)} AND project = ${sqlString(update.row.project)};`),
    ...plan.daily
      .filter(update => update.changed && update.row.usage_date === usageDate)
      .map(update => `UPDATE daily_usage
SET estimated_cost_usd = ${sqlNumber(update.estimatedCostUsd)}, cost_status = ${sqlString(update.costStatus)}, pricing_version = ${sqlString(update.pricingVersion)}, top_project_by_cost = ${sqlString(update.topProject)}, top_project_cost_usd = ${sqlNumber(update.topProjectCostUsd)}, top_model_by_cost = ${sqlString(update.topModel)}, top_model_cost_usd = ${sqlNumber(update.topModelCostUsd)}, updated_at = ${sqlString(updatedAt)}
WHERE device_id = ${sqlString(update.row.device_id)} AND usage_date = ${sqlString(update.row.usage_date)};`),
  ];
  if (statements.length === 0) return '';
  return ['BEGIN;', ...statements, 'COMMIT;'].join('\n');
}

/** Stable comparison input for the post-apply token-facts safety gate. */
export function snapshotTokenFacts(
  breakdownRows: DatabaseBreakdownRow[],
  dailyRows: DatabaseDailyRow[],
): string {
  const breakdownFacts = breakdownRows
    .map(row => [
      row.device_id,
      row.usage_date,
      row.provider,
      row.product,
      row.channel,
      row.model,
      row.project,
      ...TOKEN_COLUMNS.map(column => number(row[column])),
    ])
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const dailyFacts = dailyRows
    .map(row => [
      row.device_id,
      row.usage_date,
      ...[
        'event_count',
        'input_tokens',
        'cached_input_tokens',
        'cache_write_tokens',
        'output_tokens',
        'reasoning_output_tokens',
      ].map(column => number(row[column as keyof DatabaseDailyRow] as number)),
    ])
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return JSON.stringify({ breakdownFacts, dailyFacts });
}

type BreakdownCostSummaryRow = Pick<
  DatabaseBreakdownRow,
  'event_count'
  | 'input_tokens'
  | 'cached_input_tokens'
  | 'cache_write_tokens'
  | 'output_tokens'
  | 'reasoning_output_tokens'
  | 'estimated_cost_usd'
  | 'cost_status'
>;

function summarizeBreakdowns(rows: BreakdownCostSummaryRow[]): CostTotals {
  let totalEvents = 0;
  let totalTokens = 0;
  let totalCostUsd = 0;
  let costBearingEvents = 0;
  for (const row of rows) {
    const eventCount = number(row.event_count);
    totalEvents += eventCount;
    totalTokens += number(row.input_tokens)
      + number(row.cached_input_tokens)
      + number(row.cache_write_tokens)
      + number(row.output_tokens)
      + number(row.reasoning_output_tokens);
    const cost = number(row.estimated_cost_usd);
    totalCostUsd += cost;
    if (cost > 0) costBearingEvents += eventCount;
  }
  return {
    totalEvents,
    totalTokens,
    totalCostUsd: roundUsd(totalCostUsd),
    costBearingEvents,
  };
}

function summarizeModelCostChanges(
  rows: DatabaseBreakdownRow[],
  updates: BreakdownUpdate[],
): ModelCostChange[] {
  const map = new Map<string, ModelCostChange & { beforeStatuses: CostStatus[]; afterStatuses: CostStatus[] }>();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const update = updates[index];
    const key = `${row.provider}\\0${row.product}\\0${row.model}`;
    const tokens = number(row.input_tokens)
      + number(row.cached_input_tokens)
      + number(row.cache_write_tokens)
      + number(row.output_tokens)
      + number(row.reasoning_output_tokens);
    const existing = map.get(key);
    if (existing) {
      existing.rows += 1;
      existing.totalTokens += tokens;
      existing.beforeCostUsd += number(row.estimated_cost_usd);
      existing.afterCostUsd += update.estimatedCostUsd;
      existing.beforeStatuses.push(row.cost_status);
      existing.afterStatuses.push(update.costStatus);
    } else {
      map.set(key, {
        provider: row.provider,
        product: row.product,
        model: row.model,
        rows: 1,
        totalTokens: tokens,
        beforeCostUsd: number(row.estimated_cost_usd),
        afterCostUsd: update.estimatedCostUsd,
        beforeStatus: row.cost_status,
        afterStatus: update.costStatus,
        beforeStatuses: [row.cost_status],
        afterStatuses: [update.costStatus],
      });
    }
  }
  return [...map.values()]
    .map(({ beforeStatuses, afterStatuses, ...change }) => ({
      ...change,
      beforeCostUsd: roundUsd(change.beforeCostUsd),
      afterCostUsd: roundUsd(change.afterCostUsd),
      beforeStatus: getWorstCostStatus(beforeStatuses),
      afterStatus: getWorstCostStatus(afterStatuses),
    }))
    .filter(change => change.beforeCostUsd !== change.afterCostUsd || change.beforeStatus !== change.afterStatus)
    .sort((left, right) => Math.abs(right.afterCostUsd - right.beforeCostUsd) - Math.abs(left.afterCostUsd - left.beforeCostUsd));
}

function summarizeUnavailable(updates: BreakdownUpdate[]): UnavailableModelSummary[] {
  const map = new Map<string, UnavailableModelSummary>();
  for (const update of updates) {
    if (update.costStatus !== 'unavailable') continue;
    const tokens = number(update.row.input_tokens)
      + number(update.row.cached_input_tokens)
      + number(update.row.cache_write_tokens)
      + number(update.row.output_tokens)
      + number(update.row.reasoning_output_tokens);
    if (tokens <= 0) continue;
    const key = `${update.row.provider}\0${update.row.product}\0${update.row.model}`;
    const existing = map.get(key);
    if (existing) {
      existing.rows += 1;
      existing.totalTokens += tokens;
    } else {
      map.set(key, {
        provider: update.row.provider,
        product: update.row.product,
        model: update.row.model,
        rows: 1,
        totalTokens: tokens,
      });
    }
  }
  return [...map.values()].sort((left, right) => right.totalTokens - left.totalTokens || left.model.localeCompare(right.model));
}

function parseExtraMetrics(row: DatabaseBreakdownRow): Record<string, unknown> | null {
  if (!row.extra_metrics_json) return null;
  try {
    const value: unknown = JSON.parse(row.extra_metrics_json);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function cacheWriteTokens(row: DatabaseBreakdownRow, key: string): number {
  const extra = parseExtraMetrics(row);
  const value = extra?.[key];
  return value == null ? number(row.cache_write_tokens) : number(value as number);
}

function isVendorReportedProduct(product: string): boolean {
  return product === 'opencode' || product === 'trae-intl';
}

function publicProjectLabel(row: DatabaseBreakdownRow): string {
  return row.project_alias || row.project_display || row.project || 'unknown';
}

function addCost(map: Map<string, number>, key: string, cost: number): void {
  map.set(key, (map.get(key) ?? 0) + cost);
}

function topEntry(map: Map<string, number> | undefined): { name: string; cost: number } | null {
  if (!map || map.size === 0) return null;
  return [...map.entries()]
    .sort(([leftName, leftCost], [rightName, rightCost]) => rightCost - leftCost || leftName.localeCompare(rightName))
    .map(([name, cost]) => ({ name, cost }))[0] ?? null;
}

function dailyKey(deviceId: string, usageDate: string): string {
  return `${deviceId}\0${usageDate}`;
}

function number(value: unknown): number {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}

function roundUsd(value: number): number {
  return Math.round(number(value) * 10000) / 10000;
}

function sqlString(value: string | null): string {
  if (value == null) return 'NULL';
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlNumber(value: number): string {
  return String(roundUsd(value));
}
