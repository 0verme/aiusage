import {
  calculateCost,
  canonicalizeModel,
  getPricingCatalog,
  getWorstCostStatus,
  type CostStatus,
  type CostSource,
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
  cost_source: CostSource;
  reported_cost_usd: number | null;
  reported_cost_source: string | null;
  output_tokens_includes_reasoning: number | null;
  prior_estimated_cost_usd: number | null;
  prior_cost_status: CostStatus | null;
  prior_cost_source: CostSource | null;
  prior_pricing_version: string | null;
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
  cost_source: CostSource;
  top_project_by_cost: string | null;
  top_project_cost_usd: number | null;
  top_model_by_cost: string | null;
  top_model_cost_usd: number | null;
  prior_estimated_cost_usd: number | null;
  prior_cost_status: CostStatus | null;
  prior_cost_source: CostSource | null;
  prior_pricing_version: string | null;
}

export type CompatibleColumn = string | { name: string; fallbackSql: string };

/** Build a read-only select that can preview data before provenance migrations exist. */
export function buildCompatibleSelect(
  table: string,
  availableColumns: ReadonlySet<string>,
  columns: readonly CompatibleColumn[],
  suffix = '',
): string {
  if (!/^[a-z_]+$/.test(table)) throw new Error('表名无效');
  const selected = columns.map(column => {
    if (typeof column === 'string') {
      if (!availableColumns.has(column)) throw new Error(`缺少必要列: ${column}`);
      return column;
    }
    if (!/^[a-z_]+$/.test(column.name)) throw new Error('列名无效');
    return availableColumns.has(column.name) ? column.name : `${column.fallbackSql} AS ${column.name}`;
  });
  return `SELECT ${selected.join(', ')} FROM ${table}${suffix}`;
}

export interface BreakdownUpdate {
  row: DatabaseBreakdownRow;
  estimatedCostUsd: number;
  costStatus: CostStatus;
  costSource: CostSource;
  pricingVersion: string;
  changed: boolean;
}

export interface DailyUpdate {
  row: DatabaseDailyRow;
  estimatedCostUsd: number;
  costStatus: CostStatus;
  costSource: CostSource;
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
  coveredTokens: number;
  unpricedTokens: number;
  legacyUnknownTokens: number;
  explicitFreeTokens: number;
  clientReportedEstimateUsd: number;
  coveragePercent: number;
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
  scopedCostChanges: ScopedCostChange[];
}

export interface ScopedCostChange {
  deviceId: string;
  usageDate: string;
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

export interface RecalculationPlan {
  breakdowns: BreakdownUpdate[];
  daily: DailyUpdate[];
  summary: RecalculationSummary;
}

export interface RecalculationScope {
  deviceIds?: readonly string[];
  products?: readonly string[];
  models?: readonly string[];
  rawProviders?: readonly string[];
}

interface DayAggregate {
  totalCostUsd: number;
  statuses: CostStatus[];
  sources: CostSource[];
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
    scope?: RecalculationScope;
  } = {},
): RecalculationPlan {
  const catalog = options.catalog ?? getPricingCatalog();
  const scoped = hasRecalculationScope(options.scope);
  const breakdowns = breakdownRows.map(row => matchesRecalculationScope(row, options.scope)
    ? calculateBreakdownUpdate(row, catalog)
    : preserveBreakdownCost(row, catalog.version));
  const aggregates = new Map<string, DayAggregate>();

  for (const update of breakdowns) {
    const key = dailyKey(update.row.device_id, update.row.usage_date);
    let aggregate = aggregates.get(key);
    if (!aggregate) {
      aggregate = {
        totalCostUsd: 0,
        statuses: [],
        sources: [],
        projects: new Map(),
        models: new Map(),
      };
      aggregates.set(key, aggregate);
    }
    aggregate.totalCostUsd += update.estimatedCostUsd;
    aggregate.statuses.push(update.costStatus);
    aggregate.sources.push(update.costSource);
    addCost(aggregate.projects, publicProjectLabel(update.row), update.estimatedCostUsd);
    addCost(aggregate.models, canonicalizeModel(update.row.model), update.estimatedCostUsd);
  }

  const changedDates = new Set(breakdowns.filter(update => update.changed)
    .map(update => dailyKey(update.row.device_id, update.row.usage_date)));
  const daily = dailyRows.map(row => {
    if (scoped && !changedDates.has(dailyKey(row.device_id, row.usage_date))) {
      return preserveDailyCost(row, catalog.version);
    }
    return buildDailyUpdate(row, aggregates.get(dailyKey(row.device_id, row.usage_date)), catalog.version);
  });
  const before = summarizeBreakdowns(breakdownRows);
  const after = summarizeBreakdowns(breakdowns.map(update => ({
    ...update.row,
    estimated_cost_usd: update.estimatedCostUsd,
    cost_status: update.costStatus,
    cost_source: update.costSource,
  })));
  const costDeltaUsd = roundUsd(after.totalCostUsd - before.totalCostUsd);
  const scopedRows = breakdownRows.filter(row => matchesRecalculationScope(row, options.scope));
  const scopedUpdates = breakdowns.filter(update => matchesRecalculationScope(update.row, options.scope));

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
      unavailableRowsBefore: scopedRows.filter(row => row.cost_status === 'unavailable').length,
      unavailableRowsAfter: scopedUpdates.filter(update => update.costStatus === 'unavailable').length,
      modelsStillUnavailable: summarizeUnavailable(scopedUpdates),
      modelCostChanges: summarizeModelCostChanges(scopedRows, scopedUpdates),
      scopedCostChanges: summarizeScopedCostChanges(scopedRows, scopedUpdates),
    },
  };
}

function hasRecalculationScope(scope?: RecalculationScope): boolean {
  return Boolean(scope && (
    scope.deviceIds?.length || scope.products?.length || scope.models?.length || scope.rawProviders?.length
  ));
}

function matchesRecalculationScope(
  row: DatabaseBreakdownRow,
  scope?: RecalculationScope,
): boolean {
  if (!hasRecalculationScope(scope)) return true;
  return (!scope?.deviceIds?.length || scope.deviceIds.includes(row.device_id))
    && (!scope?.products?.length || scope.products.includes(row.product))
    && (!scope?.models?.length || scope.models.includes(row.model))
    && (!scope?.rawProviders?.length || matchesRecordedRawProvider(row, scope.rawProviders));
}

function matchesRecordedRawProvider(row: DatabaseBreakdownRow, rawProviders: readonly string[]): boolean {
  const extra = parseExtraMetrics(row);
  const recorded = extra?.raw_providers;
  if (Array.isArray(recorded)) {
    if (recorded.some(provider => typeof provider !== 'string' || !provider.trim())) return false;
    const unique = [...new Set(recorded.map(provider => (provider as string).trim().toLowerCase()))];
    return unique.length === 1 && rawProviders.some(provider => provider.trim().toLowerCase() === unique[0]);
  }
  const single = extra?.raw_provider;
  return typeof single === 'string' && rawProviders.some(provider => provider.trim().toLowerCase() === single.trim().toLowerCase());
}

function preserveBreakdownCost(row: DatabaseBreakdownRow, currentPricingVersion: string): BreakdownUpdate {
  return {
    row,
    estimatedCostUsd: roundUsd(row.estimated_cost_usd),
    costStatus: row.cost_status,
    costSource: row.cost_source,
    pricingVersion: row.pricing_version ?? currentPricingVersion,
    changed: false,
  };
}

function preserveDailyCost(row: DatabaseDailyRow, currentPricingVersion: string): DailyUpdate {
  return {
    row,
    estimatedCostUsd: roundUsd(row.estimated_cost_usd),
    costStatus: row.cost_status,
    costSource: row.cost_source,
    pricingVersion: row.pricing_version ?? currentPricingVersion,
    topProject: row.top_project_by_cost ?? 'unknown',
    topProjectCostUsd: roundUsd(row.top_project_cost_usd ?? 0),
    topModel: row.top_model_by_cost ?? 'unknown',
    topModelCostUsd: roundUsd(row.top_model_cost_usd ?? 0),
    changed: false,
  };
}

function calculateBreakdownUpdate(row: DatabaseBreakdownRow, catalog: PricingCatalog): BreakdownUpdate {
  const hasExplicitProviderActual = row.cost_source === 'provider_actual' && Number(row.estimated_cost_usd) >= 0;
  const existingVendorCost = hasExplicitProviderActual;
  const preserveCurrentPerRequestEstimate = row.cost_source === 'catalog_estimate'
    && row.pricing_version === catalog.version
    && costGranularityForRow(row) === 'per_request'
    && row.cost_status !== 'unavailable'
    && Number.isFinite(Number(row.estimated_cost_usd))
    && Number(row.estimated_cost_usd) >= 0;
  const outputIncludesReasoning = row.output_tokens_includes_reasoning == null
    ? isLegacyCodexIdentity(row)
    : Number(row.output_tokens_includes_reasoning) !== 0;
  const evidence = costEvidenceForRow(row);
  const isCodexCatalogIdentity = isLegacyCodexIdentity(row);
  const pricingModel = pricingModelForRow(row);
  const catalogModel = isCodexCatalogIdentity && evidence !== 'per_request'
    ? stripRecordedServiceTier(pricingModel)
    : pricingModel;
  const result = existingVendorCost
    ? {
      estimatedCostUsd: Number(row.estimated_cost_usd),
      costStatus: 'exact' as const,
      costSource: 'provider_actual' as const,
    }
    : preserveCurrentPerRequestEstimate
      ? {
        estimatedCostUsd: Number(row.estimated_cost_usd),
        costStatus: row.cost_status,
        costSource: 'catalog_estimate' as const,
      }
    : (() => {
      const pricingProvider = pricingProviderForRow(row);
      if (!pricingProvider) {
        return {
          estimatedCostUsd: 0,
          costStatus: 'unavailable' as const,
          costSource: 'unavailable' as const,
        };
      }
      const calculated = calculateCost(
      pricingProvider,
      row.product,
      catalogModel,
      {
        inputTokens: number(row.input_tokens),
        cachedInputTokens: number(row.cached_input_tokens),
        cacheWriteTokens: number(row.cache_write_tokens),
        cacheWrite5mTokens: cacheWriteTokens(row, 'cache_write_5m_tokens'),
        cacheWrite1hTokens: cacheWriteTokens(row, 'cache_write_1h_tokens'),
        outputTokens: number(row.output_tokens),
        reasoningOutputTokens: outputIncludesReasoning ? 0 : number(row.reasoning_output_tokens),
      },
      {
        requestCount: number(row.event_count),
        catalog,
        costEvidence: isCodexCatalogIdentity && evidence !== 'per_request' ? 'assumed_standard' : evidence,
      },
      );
      return {
        estimatedCostUsd: calculated.estimatedCostUsd,
        costStatus: calculated.costStatus,
        costSource: calculated.isFree
          ? 'explicit_free' as const
          : calculated.costStatus === 'unavailable' ? 'unavailable' as const : 'catalog_estimate' as const,
      };
    })();

  const estimatedCostUsd = roundUsd(result.estimatedCostUsd);
  const costSource: CostSource = result.costSource;
  return {
    row,
    estimatedCostUsd,
    costStatus: result.costStatus,
    costSource,
    pricingVersion: catalog.version,
    changed: estimatedCostUsd !== roundUsd(row.estimated_cost_usd)
      || result.costStatus !== row.cost_status
      || costSource !== row.cost_source
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
  const costSource = aggregate ? combineCostSources(aggregate.sources) : 'legacy_unknown';
  const topProject = topEntry(aggregate?.projects) ?? { name: 'unknown', cost: 0 };
  const topModel = topEntry(aggregate?.models) ?? { name: 'unknown', cost: 0 };
  const topProjectCostUsd = roundUsd(topProject.cost);
  const topModelCostUsd = roundUsd(topModel.cost);

  return {
    row,
    estimatedCostUsd: totalCostUsd,
    costStatus,
    costSource,
    pricingVersion,
    topProject: topProject.name,
    topProjectCostUsd,
    topModel: topModel.name,
    topModelCostUsd,
    changed: totalCostUsd !== roundUsd(row.estimated_cost_usd)
      || costStatus !== row.cost_status
      || costSource !== row.cost_source
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
SET prior_estimated_cost_usd = COALESCE(prior_estimated_cost_usd, estimated_cost_usd), prior_cost_status = COALESCE(prior_cost_status, cost_status), prior_cost_source = COALESCE(prior_cost_source, cost_source), prior_pricing_version = COALESCE(prior_pricing_version, pricing_version), estimated_cost_usd = ${sqlNumber(update.estimatedCostUsd)}, cost_status = ${sqlString(update.costStatus)}, cost_source = ${sqlString(update.costSource)}, pricing_version = ${sqlString(update.pricingVersion)}, updated_at = ${sqlString(updatedAt)}
WHERE device_id = ${sqlString(update.row.device_id)} AND usage_date = ${sqlString(update.row.usage_date)} AND provider = ${sqlString(update.row.provider)} AND product = ${sqlString(update.row.product)} AND channel = ${sqlString(update.row.channel)} AND model = ${sqlString(update.row.model)} AND project = ${sqlString(update.row.project)};`),
    ...plan.daily
      .filter(update => update.changed && update.row.usage_date === usageDate)
      .map(update => `UPDATE daily_usage
SET prior_estimated_cost_usd = COALESCE(prior_estimated_cost_usd, estimated_cost_usd), prior_cost_status = COALESCE(prior_cost_status, cost_status), prior_cost_source = COALESCE(prior_cost_source, cost_source), prior_pricing_version = COALESCE(prior_pricing_version, pricing_version), estimated_cost_usd = ${sqlNumber(update.estimatedCostUsd)}, cost_status = ${sqlString(update.costStatus)}, cost_source = ${sqlString(update.costSource)}, pricing_version = ${sqlString(update.pricingVersion)}, top_project_by_cost = ${sqlString(update.topProject)}, top_project_cost_usd = ${sqlNumber(update.topProjectCostUsd)}, top_model_by_cost = ${sqlString(update.topModel)}, top_model_cost_usd = ${sqlNumber(update.topModelCostUsd)}, updated_at = ${sqlString(updatedAt)}
WHERE device_id = ${sqlString(update.row.device_id)} AND usage_date = ${sqlString(update.row.usage_date)};`),
  ];
  if (statements.length === 0) return '';
  // D1's remote SQL endpoint rejects explicit BEGIN/COMMIT statements. The
  // caller still batches one date at a time and every statement is idempotent,
  // so a retry converges without touching token facts.
  return statements.join('\n');
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
      row.output_tokens_includes_reasoning,
      row.extra_metrics_json,
      row.reported_cost_usd,
      row.reported_cost_source,
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
  'provider'
  | 'product'
  | 'event_count'
  | 'input_tokens'
  | 'cached_input_tokens'
  | 'cache_write_tokens'
  | 'output_tokens'
  | 'reasoning_output_tokens'
  | 'estimated_cost_usd'
  | 'cost_status'
  | 'cost_source'
  | 'reported_cost_usd'
  | 'output_tokens_includes_reasoning'
>;

function summarizeBreakdowns(rows: BreakdownCostSummaryRow[]): CostTotals {
  let totalEvents = 0;
  let totalTokens = 0;
  let totalCostUsd = 0;
  let costBearingEvents = 0;
  let coveredTokens = 0;
  let unpricedTokens = 0;
  let legacyUnknownTokens = 0;
  let explicitFreeTokens = 0;
  let clientReportedEstimateUsd = 0;
  for (const row of rows) {
    const eventCount = number(row.event_count);
    totalEvents += eventCount;
    const tokens = effectiveTokens(row);
    totalTokens += tokens;
    if (row.cost_status === 'unavailable' || row.cost_source === 'legacy_unknown') unpricedTokens += tokens;
    else coveredTokens += tokens;
    if (row.cost_source === 'legacy_unknown') legacyUnknownTokens += tokens;
    if (row.cost_source === 'explicit_free') explicitFreeTokens += tokens;
    clientReportedEstimateUsd += number(row.reported_cost_usd);
    const cost = number(row.estimated_cost_usd);
    totalCostUsd += cost;
    if (cost > 0) costBearingEvents += eventCount;
  }
  return {
    totalEvents,
    totalTokens,
    totalCostUsd: roundUsd(totalCostUsd),
    costBearingEvents,
    coveredTokens,
    unpricedTokens,
    legacyUnknownTokens,
    explicitFreeTokens,
    clientReportedEstimateUsd: roundUsd(clientReportedEstimateUsd),
    coveragePercent: totalTokens > 0 ? roundUsd((coveredTokens / totalTokens) * 100) : 100,
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
    const tokens = effectiveTokens(row);
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

function summarizeScopedCostChanges(
  rows: DatabaseBreakdownRow[],
  updates: BreakdownUpdate[],
): ScopedCostChange[] {
  const map = new Map<string, ScopedCostChange & { beforeStatuses: CostStatus[]; afterStatuses: CostStatus[] }>();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const update = updates[index];
    const key = [row.device_id, row.usage_date, row.provider, row.product, row.model].join('\0');
    const tokens = effectiveTokens(row);
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
        deviceId: row.device_id,
        usageDate: row.usage_date,
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
    .sort((left, right) => left.usageDate.localeCompare(right.usageDate)
      || left.deviceId.localeCompare(right.deviceId)
      || Math.abs(right.afterCostUsd - right.beforeCostUsd) - Math.abs(left.afterCostUsd - left.beforeCostUsd));
}

function summarizeUnavailable(updates: BreakdownUpdate[]): UnavailableModelSummary[] {
  const map = new Map<string, UnavailableModelSummary>();
  for (const update of updates) {
    if (update.costStatus !== 'unavailable') continue;
    const tokens = effectiveTokens(update.row);
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

function pricingModelForRow(row: DatabaseBreakdownRow): string {
  const extra = parseExtraMetrics(row);
  const pricingModel = extra?.pricing_model_key;
  return typeof pricingModel === 'string' && pricingModel.trim()
    ? pricingModel
    : row.model;
}

function pricingProviderForRow(row: DatabaseBreakdownRow): string | null {
  const extra = parseExtraMetrics(row);
  const rawProviders = extra?.raw_providers;
  if (Array.isArray(rawProviders) && rawProviders.length > 0) {
    const providers = rawProviders.filter((provider): provider is string =>
      typeof provider === 'string' && provider.trim().length > 0,
    );
    const uniqueProviders = new Set(providers.map(provider => provider.trim().toLowerCase()));
    // The historical row may merge multiple gateways after provider normalization.
    // Choosing the first route would silently apply one route's price to all tokens.
    if (providers.length !== rawProviders.length || uniqueProviders.size !== 1) return null;
    return providers[0];
  }
  const rawProvider = extra?.raw_provider;
  return typeof rawProvider === 'string' && rawProvider.trim() ? rawProvider : row.provider;
}

function isLegacyCodexIdentity(row: Pick<DatabaseBreakdownRow, 'provider' | 'product'>): boolean {
  return row.product === 'codex'
    && ['openai', 'openai-codex', 'openai_codex'].includes(row.provider);
}

function costEvidenceForRow(row: DatabaseBreakdownRow): 'per_request' | 'aggregate' | 'assumed_standard' | 'unknown' {
  const extra = parseExtraMetrics(row);
  const evidence = extra?.cost_evidence;
  if (evidence === 'per_request' || evidence === 'aggregate' || evidence === 'assumed_standard') return evidence;
  if (row.cost_source === 'client_estimate') return 'aggregate';
  return 'unknown';
}

function costGranularityForRow(row: DatabaseBreakdownRow): 'per_request' | 'aggregate' | 'unknown' {
  const extra = parseExtraMetrics(row);
  const granularity = extra?.cost_granularity;
  return granularity === 'per_request' || granularity === 'aggregate' ? granularity : 'unknown';
}

function stripRecordedServiceTier(model: string): string {
  return model
    .replace(/-(fast|priority)$/i, '')
    .replace(/\/(fast|priority)$/i, '');
}

function combineCostSources(sources: CostSource[]): CostSource {
  const normalized = [...new Set(sources)];
  if (normalized.length === 0) return 'legacy_unknown';
  return normalized.length === 1 ? normalized[0] : 'mixed';
}

function effectiveTokens(row: BreakdownCostSummaryRow): number {
  const outputIncludesReasoning = row.output_tokens_includes_reasoning == null
    ? isLegacyCodexIdentity(row)
    : Number(row.output_tokens_includes_reasoning) !== 0;
  return number(row.input_tokens)
    + number(row.cached_input_tokens)
    + number(row.cache_write_tokens)
    + number(row.output_tokens)
    + (outputIncludesReasoning ? 0 : number(row.reasoning_output_tokens));
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
