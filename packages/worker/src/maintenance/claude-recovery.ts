import { canonicalModelSqlExpression } from "@aiusage/shared";

const MODEL_SQL = canonicalModelSqlExpression("b.model");

export const CLAUDE_PRODUCT_ALIASES = [
	"claude-code",
	"claudecode",
	"claude-cli",
	"claude-code-cli",
	"claude",
] as const;

/** These fields are compared as raw SQLite TEXT values; do not normalize case. */
export const CLAUDE_BREAKDOWN_KEY_FIELDS = [
	"device_id",
	"usage_date",
	"provider",
	"product",
	"channel",
	"model",
	"project",
] as const;

export const CLAUDE_BREAKDOWN_COMPARE_FIELDS = [
	"event_count",
	"session_count",
	"input_tokens",
	"cached_input_tokens",
	"cache_write_tokens",
	"output_tokens",
	"reasoning_output_tokens",
	"estimated_cost_usd",
	"extra_metrics_json",
] as const;

export const CLAUDE_ACTIVITY_KEY_FIELDS = [
	"device_id",
	"usage_date",
	"provider",
	"product",
	"source",
	"project",
	"kind",
	"name",
	"confidence",
] as const;

export const CLAUDE_ACTIVITY_COMPARE_FIELDS = [
	"project_display",
	"project_alias",
	"event_count",
] as const;

export const BREAKDOWN_INSERT_COLUMNS = [
	"device_id",
	"usage_date",
	"provider",
	"product",
	"channel",
	"model",
	"project",
	"project_display",
	"project_alias",
	"event_count",
	"session_count",
	"input_tokens",
	"cached_input_tokens",
	"cache_write_tokens",
	"output_tokens",
	"reasoning_output_tokens",
	"estimated_cost_usd",
	"cost_status",
	"pricing_version",
	"extra_metrics_json",
	"source_meta_json",
	"created_at",
	"updated_at",
] as const;

export type RawDatabaseRow = Record<string, unknown>;
export type BreakdownRow = RawDatabaseRow;
export type ActivityRow = RawDatabaseRow;

export interface FieldDifference {
	field: string;
	historical: unknown;
	current: unknown;
}

export interface RowConflict<T extends RawDatabaseRow = RawDatabaseRow> {
	key: Record<string, unknown>;
	historical: T;
	current: T;
	differences: FieldDifference[];
}

export interface DatasetDiff<T extends RawDatabaseRow = RawDatabaseRow> {
	missing: T[];
	conflicts: RowConflict<T>[];
	currentOnly: T[];
}

export interface TokenTotals {
	inputTokens: number;
	cachedInputTokens: number;
	cacheWriteTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	totalTokens: number;
}

export interface DatasetSummary extends TokenTotals {
	firstDate: string | null;
	lastDate: string | null;
	dates: string[];
	dateCount: number;
	rows: number;
	events: number;
	sessions: number;
	estimatedCostUsd: number;
}

export interface ActivitySummary {
	firstDate: string | null;
	lastDate: string | null;
	dates: string[];
	dateCount: number;
	rows: number;
	events: number;
}

export interface DailyCoverage {
	date: string;
	rows: number;
	providers: string[];
	models: string[];
	projects: string[];
	events: number;
	inputTokens: number;
	cachedInputTokens: number;
	cacheWriteTokens: number;
	outputTokens: number;
	estimatedCostUsd: number;
}

export interface DailyDifference {
	date: string;
	historicalRows: number;
	currentRows: number;
	missingRows: number;
	conflictRows: number;
	currentOnlyRows: number;
	status: "OK" | "MISSING" | "PARTIAL" | "CONFLICT";
}

export interface DateRange {
	from: string;
	to: string;
}

export interface AffectedDay {
	device_id: string;
	usage_date: string;
}

export interface MissingAggregate extends TokenTotals {
	group: string;
	rows: number;
	events: number;
	sessions: number;
	estimatedCostUsd: number;
}

export interface ProductPairSummary {
	provider: string;
	product: string;
	rows: number;
	firstDate: string | null;
	lastDate: string | null;
}

export interface ActivityDiffReport {
	historical: ActivitySummary;
	current: ActivitySummary;
	missingRows: ActivityRow[];
	conflicts: RowConflict<ActivityRow>[];
	currentOnlyRows: ActivityRow[];
	missingDates: string[];
	missingDateRanges: string[];
	missingEvents: number;
}

export interface ClaudeDiffReport {
	generatedAt: string;
	claudeProducts: string[];
	historicalProductPairs: ProductPairSummary[];
	currentProductPairs: ProductPairSummary[];
	historical: DatasetSummary;
	current: DatasetSummary;
	historicalCoverage: DailyCoverage[];
	currentCoverage: DailyCoverage[];
	missingRows: BreakdownRow[];
	conflicts: RowConflict<BreakdownRow>[];
	currentOnlyRows: BreakdownRow[];
	missingDates: string[];
	missingDateRanges: string[];
	daily: DailyDifference[];
	missingSummary: DatasetSummary;
	missingByProvider: MissingAggregate[];
	missingByModel: MissingAggregate[];
	missingByProject: MissingAggregate[];
	missingByDate: MissingAggregate[];
	affectedDays: AffectedDay[];
	affectedDates: string[];
	activity: ActivityDiffReport;
}

const NUMERIC_BREAKDOWN_FIELDS = [
	"event_count",
	"session_count",
	"input_tokens",
	"cached_input_tokens",
	"cache_write_tokens",
	"output_tokens",
	"reasoning_output_tokens",
	"estimated_cost_usd",
] as const;

/** Normalize only product spelling; provider is intentionally not used as a filter. */
export function normalizeClaudeProduct(product: unknown): string {
	return String(product ?? "")
		.trim()
		.toLowerCase()
		.replaceAll("_", "-")
		.replaceAll(/\s+/g, "-")
		.replaceAll(/-+/g, "-");
}

/**
 * Product is the source of truth for Claude Code selection. Do not select rows
 * merely because their model contains "claude": OpenCode, Copilot, and other
 * products can legitimately use Claude models.
 */
export function isClaudeCodeProduct(
	product: unknown,
	extraProducts: readonly string[] = [],
): boolean {
	const normalized = normalizeClaudeProduct(product);
	const configured = new Set([
		...CLAUDE_PRODUCT_ALIASES,
		...extraProducts.map(normalizeClaudeProduct),
	]);
	if (configured.has(normalized)) return true;

	// Allow versioned historical names such as claude-code-v1 without opening
	// the filter to unrelated products such as claude-api or anthropic.
	return /^claude-code-(?:v)?\d+(?:[-.]\d+)*$/.test(normalized);
}

export function selectClaudeRows<T extends RawDatabaseRow>(
	rows: readonly T[],
	extraProducts: readonly string[] = [],
): T[] {
	return rows.filter((row) => isClaudeCodeProduct(row.product, extraProducts));
}

export function summarizeProductPairs(
	rows: readonly RawDatabaseRow[],
): ProductPairSummary[] {
	const groups = new Map<string, ProductPairSummary>();
	for (const row of rows) {
		const provider = stringValue(row.provider, "unknown");
		const product = stringValue(row.product, "unknown");
		const key = JSON.stringify([provider, product]);
		const date = stringValue(row.usage_date, "");
		const existing = groups.get(key);
		if (existing) {
			existing.rows += 1;
			existing.firstDate = minDate(existing.firstDate, date);
			existing.lastDate = maxDate(existing.lastDate, date);
		} else {
			groups.set(key, {
				provider,
				product,
				rows: 1,
				firstDate: date || null,
				lastDate: date || null,
			});
		}
	}
	return [...groups.values()].sort(
		(left, right) =>
			compareStrings(left.firstDate ?? "", right.firstDate ?? "") ||
			compareStrings(left.provider, right.provider) ||
			compareStrings(left.product, right.product),
	);
}

export function diffClaudeRows<T extends RawDatabaseRow>(
	historical: readonly T[],
	current: readonly T[],
): DatasetDiff<T> {
	return diffRows(
		historical,
		current,
		CLAUDE_BREAKDOWN_KEY_FIELDS,
		CLAUDE_BREAKDOWN_COMPARE_FIELDS,
	);
}

export function diffClaudeActivityRows<T extends RawDatabaseRow>(
	historical: readonly T[],
	current: readonly T[],
): DatasetDiff<T> {
	return diffRows(
		historical,
		current,
		CLAUDE_ACTIVITY_KEY_FIELDS,
		CLAUDE_ACTIVITY_COMPARE_FIELDS,
	);
}

function diffRows<T extends RawDatabaseRow>(
	historical: readonly T[],
	current: readonly T[],
	keyFields: readonly string[],
	fieldsToCompare: readonly string[],
): DatasetDiff<T> {
	const historicalMap = indexRows(historical, keyFields, "historical");
	const currentMap = indexRows(current, keyFields, "current");
	const missing: T[] = [];
	const conflicts: RowConflict<T>[] = [];
	const currentOnly: T[] = [];

	for (const [key, historicalRow] of historicalMap) {
		const currentRow = currentMap.get(key);
		if (!currentRow) {
			missing.push(historicalRow);
			continue;
		}
		const differences = compareFields(
			historicalRow,
			currentRow,
			fieldsToCompare,
		);
		if (differences.length > 0) {
			conflicts.push({
				key: keyObject(historicalRow, keyFields),
				historical: historicalRow,
				current: currentRow,
				differences,
			});
		}
	}

	for (const [key, currentRow] of currentMap) {
		if (!historicalMap.has(key)) currentOnly.push(currentRow);
	}

	return {
		missing: sortRowsByFields(missing, keyFields),
		conflicts: conflicts.sort((left, right) =>
			compareObjects(left.key, right.key, keyFields),
		),
		currentOnly: sortRowsByFields(currentOnly, keyFields),
	};
}

export function buildDatasetSummary(
	rows: readonly RawDatabaseRow[],
): DatasetSummary {
	const dates = uniqueSortedDates(rows);
	const tokenTotals = sumTokenTotals(rows);
	return {
		...tokenTotals,
		firstDate: dates[0] ?? null,
		lastDate: dates.at(-1) ?? null,
		dates,
		dateCount: dates.length,
		rows: rows.length,
		events: sum(rows, "event_count"),
		sessions: sum(rows, "session_count"),
		estimatedCostUsd: roundUsd(sum(rows, "estimated_cost_usd")),
	};
}

export function buildActivitySummary(
	rows: readonly RawDatabaseRow[],
): ActivitySummary {
	const dates = uniqueSortedDates(rows);
	return {
		firstDate: dates[0] ?? null,
		lastDate: dates.at(-1) ?? null,
		dates,
		dateCount: dates.length,
		rows: rows.length,
		events: sum(rows, "event_count"),
	};
}

export function buildDailyCoverage(
	rows: readonly RawDatabaseRow[],
): DailyCoverage[] {
	const groups = new Map<
		string,
		{
			rows: number;
			providers: Set<string>;
			models: Set<string>;
			projects: Set<string>;
			events: number;
			inputTokens: number;
			cachedInputTokens: number;
			cacheWriteTokens: number;
			outputTokens: number;
			estimatedCostUsd: number;
		}
	>();

	for (const row of rows) {
		const date = requireDate(row.usage_date);
		let group = groups.get(date);
		if (!group) {
			group = {
				rows: 0,
				providers: new Set(),
				models: new Set(),
				projects: new Set(),
				events: 0,
				inputTokens: 0,
				cachedInputTokens: 0,
				cacheWriteTokens: 0,
				outputTokens: 0,
				estimatedCostUsd: 0,
			};
			groups.set(date, group);
		}
		group.rows += 1;
		group.providers.add(stringValue(row.provider, "unknown"));
		group.models.add(stringValue(row.model, "unknown"));
		group.projects.add(stringValue(row.project, "unknown"));
		group.events += numberValue(row.event_count);
		group.inputTokens += numberValue(row.input_tokens);
		group.cachedInputTokens += numberValue(row.cached_input_tokens);
		group.cacheWriteTokens += numberValue(row.cache_write_tokens);
		group.outputTokens += numberValue(row.output_tokens);
		group.estimatedCostUsd += numberValue(row.estimated_cost_usd);
	}

	return [...groups.entries()]
		.sort(([left], [right]) => compareStrings(left, right))
		.map(([date, group]) => ({
			date,
			rows: group.rows,
			providers: [...group.providers].sort(compareStrings),
			models: [...group.models].sort(compareStrings),
			projects: [...group.projects].sort(compareStrings),
			events: group.events,
			inputTokens: group.inputTokens,
			cachedInputTokens: group.cachedInputTokens,
			cacheWriteTokens: group.cacheWriteTokens,
			outputTokens: group.outputTokens,
			estimatedCostUsd: roundUsd(group.estimatedCostUsd),
		}));
}

export function buildDailyDifferences(
	historical: readonly RawDatabaseRow[],
	current: readonly RawDatabaseRow[],
	diff: DatasetDiff,
): DailyDifference[] {
	const historicalCounts = countByDate(historical);
	const currentCounts = countByDate(current);
	const missingCounts = countByDate(diff.missing);
	const conflictCounts = countByDate(
		diff.conflicts.map((conflict) => conflict.historical),
	);
	const currentOnlyCounts = countByDate(diff.currentOnly);
	const dates = [
		...new Set([...historicalCounts.keys(), ...currentCounts.keys()]),
	].sort(compareStrings);

	return dates.map((date) => {
		const historicalRows = historicalCounts.get(date) ?? 0;
		const currentRows = currentCounts.get(date) ?? 0;
		const missingRows = missingCounts.get(date) ?? 0;
		const conflictRows = conflictCounts.get(date) ?? 0;
		const currentOnlyRows = currentOnlyCounts.get(date) ?? 0;
		let status: DailyDifference["status"] = "OK";
		if (missingRows > 0) status = currentRows > 0 ? "PARTIAL" : "MISSING";
		else if (conflictRows > 0) status = "CONFLICT";
		return {
			date,
			historicalRows,
			currentRows,
			missingRows,
			conflictRows,
			currentOnlyRows,
			status,
		};
	});
}

export function compressDateRanges(dates: readonly string[]): DateRange[] {
	const sorted = [...new Set(dates)].sort(compareStrings);
	for (const date of sorted) requireDate(date);
	const ranges: DateRange[] = [];
	for (const date of sorted) {
		const previous = ranges.at(-1);
		if (!previous || nextDate(previous.to) !== date) {
			ranges.push({ from: date, to: date });
		} else {
			previous.to = date;
		}
	}
	return ranges;
}

export function formatDateRanges(dates: readonly string[]): string[] {
	return compressDateRanges(dates).map((range) =>
		range.from === range.to ? range.from : `${range.from} ~ ${range.to}`,
	);
}

export function buildMissingAggregates(rows: readonly RawDatabaseRow[]): {
	byProvider: MissingAggregate[];
	byModel: MissingAggregate[];
	byProject: MissingAggregate[];
	byDate: MissingAggregate[];
} {
	return {
		byProvider: aggregateBy(rows, "provider"),
		byModel: aggregateBy(rows, "model"),
		byProject: aggregateBy(rows, "project"),
		byDate: aggregateBy(rows, "usage_date"),
	};
}

export function buildAffectedDays(
	rows: readonly RawDatabaseRow[],
): AffectedDay[] {
	const days = new Map<string, AffectedDay>();
	for (const row of rows) {
		const deviceId = requireString(row.device_id, "device_id");
		const usageDate = requireDate(row.usage_date);
		days.set(JSON.stringify([deviceId, usageDate]), {
			device_id: deviceId,
			usage_date: usageDate,
		});
	}
	return [...days.values()].sort(
		(left, right) =>
			compareStrings(left.device_id, right.device_id) ||
			compareStrings(left.usage_date, right.usage_date),
	);
}

export function buildActivityDiffReport(
	historical: readonly ActivityRow[],
	current: readonly ActivityRow[],
): ActivityDiffReport {
	const diff = diffClaudeActivityRows(historical, current);
	const missingDates = uniqueSortedDates(diff.missing);
	return {
		historical: buildActivitySummary(historical),
		current: buildActivitySummary(current),
		missingRows: diff.missing,
		conflicts: diff.conflicts,
		currentOnlyRows: diff.currentOnly,
		missingDates,
		missingDateRanges: formatDateRanges(missingDates),
		missingEvents: sum(diff.missing, "event_count"),
	};
}

export function buildClaudeDiffReport(options: {
	historicalRows: readonly BreakdownRow[];
	currentRows: readonly BreakdownRow[];
	historicalActivityRows: readonly ActivityRow[];
	currentActivityRows: readonly ActivityRow[];
	claudeProducts: readonly string[];
	generatedAt?: string;
}): ClaudeDiffReport {
	const breakdownDiff = diffClaudeRows(
		options.historicalRows,
		options.currentRows,
	);
	const missingSummary = buildDatasetSummary(breakdownDiff.missing);
	const missingAggregates = buildMissingAggregates(breakdownDiff.missing);
	const missingDates = uniqueSortedDates(breakdownDiff.missing);
	const affectedDays = buildAffectedDays(breakdownDiff.missing);

	return {
		generatedAt: options.generatedAt ?? new Date().toISOString(),
		claudeProducts: [
			...new Set(options.claudeProducts.map(normalizeClaudeProduct)),
		].sort(compareStrings),
		historicalProductPairs: summarizeProductPairs(options.historicalRows),
		currentProductPairs: summarizeProductPairs(options.currentRows),
		historical: buildDatasetSummary(options.historicalRows),
		current: buildDatasetSummary(options.currentRows),
		historicalCoverage: buildDailyCoverage(options.historicalRows),
		currentCoverage: buildDailyCoverage(options.currentRows),
		missingRows: breakdownDiff.missing,
		conflicts: breakdownDiff.conflicts,
		currentOnlyRows: breakdownDiff.currentOnly,
		missingDates,
		missingDateRanges: formatDateRanges(missingDates),
		daily: buildDailyDifferences(
			options.historicalRows,
			options.currentRows,
			breakdownDiff,
		),
		missingSummary,
		missingByProvider: missingAggregates.byProvider,
		missingByModel: missingAggregates.byModel,
		missingByProject: missingAggregates.byProject,
		missingByDate: missingAggregates.byDate,
		affectedDays,
		affectedDates: [...new Set(affectedDays.map((day) => day.usage_date))].sort(
			compareStrings,
		),
		activity: buildActivityDiffReport(
			options.historicalActivityRows,
			options.currentActivityRows,
		),
	};
}

export function buildRestoreMissingClaudeSql(
	rows: readonly BreakdownRow[],
	options: { generatedAt?: string } = {},
): string {
	const generatedAt = options.generatedAt ?? new Date().toISOString();
	const sortedRows = sortRowsByFields(rows, CLAUDE_BREAKDOWN_KEY_FIELDS);
	const header = [
		"-- AIUsage Claude Code historical recovery candidates",
		`-- Generated at: ${generatedAt}`,
		`-- Rows: ${sortedRows.length}`,
		"-- Safety: INSERT missing historical rows only; conflict and current-only rows are excluded.",
		"-- This artifact is intentionally not executed by the recovery tool.",
		"",
	].join("\n");

	if (sortedRows.length === 0) return `${header}-- No MISSING_CLAUDE_ROWS.\n`;

	const statements = sortedRows.map((row) => {
		const values = BREAKDOWN_INSERT_COLUMNS.map((column) =>
			sqlValueForBreakdown(row, column),
		);
		return `INSERT INTO daily_usage_breakdown (${BREAKDOWN_INSERT_COLUMNS.join(", ")})\nVALUES (${values.join(", ")})\nON CONFLICT (device_id, usage_date, provider, product, channel, model, project)\nDO NOTHING;`;
	});
	return `${header}${statements.join("\n\n")}\n`;
}

export function buildAffectedDailyUsageSql(
	affectedDays: readonly AffectedDay[],
	pricingVersion: string,
	updatedAt = new Date().toISOString(),
): string {
	const header = [
		"-- AIUsage Claude Code affected daily_usage recalculation",
		`-- Pricing version: ${pricingVersion}`,
		`-- Updated at: ${updatedAt}`,
		`-- Affected device/date pairs: ${affectedDays.length}`,
		"-- Run only after reviewing and, if approved, applying restore-missing-claude.sql.",
		"-- This script recomputes daily_usage from the complete daily_usage_breakdown table.",
		"",
	].join("\n");
	const statements = [...affectedDays]
		.sort(
			(left, right) =>
				compareStrings(left.device_id, right.device_id) ||
				compareStrings(left.usage_date, right.usage_date),
		)
		.map((day) => {
			const deviceId = sqlString(day.device_id);
			const usageDate = sqlString(day.usage_date);
			const scope = `device_id = ${deviceId} AND usage_date = ${usageDate}`;
			const topProject = `(SELECT COALESCE(project_alias, project_display)\n          FROM daily_usage_breakdown\n          WHERE ${scope}\n          GROUP BY COALESCE(project_alias, project_display)\n          ORDER BY SUM(estimated_cost_usd) DESC, COALESCE(project_alias, project_display) ASC\n          LIMIT 1)`;
			const topModel = `(SELECT ${MODEL_SQL} AS model\n          FROM daily_usage_breakdown b\n          WHERE ${scope}\n          GROUP BY ${MODEL_SQL}\n          ORDER BY SUM(b.estimated_cost_usd) DESC, ${MODEL_SQL} ASC\n          LIMIT 1)`;
			const topProjectCost = `(SELECT SUM(estimated_cost_usd)\n          FROM daily_usage_breakdown\n          WHERE ${scope}\n          GROUP BY COALESCE(project_alias, project_display)\n          ORDER BY SUM(estimated_cost_usd) DESC, COALESCE(project_alias, project_display) ASC\n          LIMIT 1)`;
			const topModelCost = `(SELECT SUM(b.estimated_cost_usd)\n          FROM daily_usage_breakdown b\n          WHERE ${scope}\n          GROUP BY ${MODEL_SQL}\n          ORDER BY SUM(b.estimated_cost_usd) DESC, ${MODEL_SQL} ASC\n          LIMIT 1)`;
			return `UPDATE daily_usage
SET event_count = COALESCE((SELECT SUM(event_count) FROM daily_usage_breakdown WHERE ${scope}), 0),
    input_tokens = COALESCE((SELECT SUM(input_tokens) FROM daily_usage_breakdown WHERE ${scope}), 0),
    cached_input_tokens = COALESCE((SELECT SUM(cached_input_tokens) FROM daily_usage_breakdown WHERE ${scope}), 0),
    cache_write_tokens = COALESCE((SELECT SUM(cache_write_tokens) FROM daily_usage_breakdown WHERE ${scope}), 0),
    output_tokens = COALESCE((SELECT SUM(output_tokens) FROM daily_usage_breakdown WHERE ${scope}), 0),
    reasoning_output_tokens = COALESCE((SELECT SUM(reasoning_output_tokens) FROM daily_usage_breakdown WHERE ${scope}), 0),
    estimated_cost_usd = ROUND(COALESCE((SELECT SUM(estimated_cost_usd) FROM daily_usage_breakdown WHERE ${scope}), 0), 4),
    cost_status = CASE
      WHEN EXISTS (SELECT 1 FROM daily_usage_breakdown WHERE ${scope} AND cost_status = 'unavailable') THEN 'unavailable'
      WHEN EXISTS (SELECT 1 FROM daily_usage_breakdown WHERE ${scope} AND cost_status = 'estimated') THEN 'estimated'
      ELSE 'exact'
    END,
    pricing_version = ${sqlString(pricingVersion)},
    top_project_by_cost = COALESCE(${topProject}, 'unknown'),
    top_project_cost_usd = ROUND(COALESCE(${topProjectCost}, 0), 4),
    top_model_by_cost = COALESCE(${topModel}, 'unknown'),
    top_model_cost_usd = ROUND(COALESCE(${topModelCost}, 0), 4),
    updated_at = ${sqlString(updatedAt)}
WHERE ${scope};`;
		});
	return `${header}${statements.join("\n\n")}${statements.length > 0 ? "\n" : "-- No affected device/date pairs.\n"}`;
}

export function sumTokenTotals(rows: readonly RawDatabaseRow[]): TokenTotals {
	const inputTokens = sum(rows, "input_tokens");
	const cachedInputTokens = sum(rows, "cached_input_tokens");
	const cacheWriteTokens = sum(rows, "cache_write_tokens");
	const outputTokens = sum(rows, "output_tokens");
	const reasoningTokens = sum(rows, "reasoning_output_tokens");
	return {
		inputTokens,
		cachedInputTokens,
		cacheWriteTokens,
		outputTokens,
		reasoningTokens,
		totalTokens:
			inputTokens +
			cachedInputTokens +
			cacheWriteTokens +
			outputTokens +
			reasoningTokens,
	};
}

function aggregateBy(
	rows: readonly RawDatabaseRow[],
	field: string,
): MissingAggregate[] {
	const groups = new Map<string, RawDatabaseRow[]>();
	for (const row of rows) {
		const value = stringValue(row[field], "unknown");
		const existing = groups.get(value);
		if (existing) existing.push(row);
		else groups.set(value, [row]);
	}
	return [...groups.entries()]
		.map(([group, groupRows]) => ({
			group,
			...sumTokenTotals(groupRows),
			rows: groupRows.length,
			events: sum(groupRows, "event_count"),
			sessions: sum(groupRows, "session_count"),
			estimatedCostUsd: roundUsd(sum(groupRows, "estimated_cost_usd")),
		}))
		.sort(
			(left, right) =>
				right.totalTokens - left.totalTokens ||
				right.estimatedCostUsd - left.estimatedCostUsd ||
				compareStrings(left.group, right.group),
		);
}

function countByDate(rows: readonly RawDatabaseRow[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const row of rows) {
		const date = stringValue(row.usage_date, "unknown");
		counts.set(date, (counts.get(date) ?? 0) + 1);
	}
	return counts;
}

function indexRows<T extends RawDatabaseRow>(
	rows: readonly T[],
	keyFields: readonly string[],
	label: string,
): Map<string, T> {
	const indexed = new Map<string, T>();
	for (const row of rows) {
		const key = rowKey(row, keyFields);
		if (indexed.has(key)) {
			throw new Error(
				`Duplicate ${label} Claude row for key ${keyObject(row, keyFields)}`,
			);
		}
		indexed.set(key, row);
	}
	return indexed;
}

function compareFields(
	historical: RawDatabaseRow,
	current: RawDatabaseRow,
	fields: readonly string[],
): FieldDifference[] {
	return fields.flatMap((field) => {
		if (
			comparableValue(historical[field], field) ===
			comparableValue(current[field], field)
		)
			return [];
		return [
			{
				field,
				historical: historical[field] ?? null,
				current: current[field] ?? null,
			},
		];
	});
}

function comparableValue(
	value: unknown,
	field: string,
): string | number | boolean | null {
	if (value == null) return null;
	if (
		(NUMERIC_BREAKDOWN_FIELDS as readonly string[]).includes(field) ||
		field === "event_count"
	) {
		return numberValue(value);
	}
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	return JSON.stringify(value) ?? String(value);
}

/** JSON string keys preserve case and avoid locale-aware/case-insensitive dedupe. */
function rowKey(row: RawDatabaseRow, fields: readonly string[]): string {
	return JSON.stringify(fields.map((field) => row[field] ?? null));
}

function keyObject(
	row: RawDatabaseRow,
	fields: readonly string[],
): Record<string, unknown> {
	return Object.fromEntries(fields.map((field) => [field, row[field] ?? null]));
}

function sortRowsByFields<T extends RawDatabaseRow>(
	rows: readonly T[],
	fields: readonly string[],
): T[] {
	return [...rows].sort((left, right) => compareObjects(left, right, fields));
}

/** SQLite's default TEXT comparison is byte/ordinal-oriented, not locale-aware. */
function compareStrings(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

function compareObjects(
	left: RawDatabaseRow,
	right: RawDatabaseRow,
	fields: readonly string[],
): number {
	for (const field of fields) {
		const leftValue = stringValue(left[field], "");
		const rightValue = stringValue(right[field], "");
		const comparison = compareStrings(leftValue, rightValue);
		if (comparison !== 0) return comparison;
	}
	return 0;
}

function uniqueSortedDates(rows: readonly RawDatabaseRow[]): string[] {
	return [...new Set(rows.map((row) => requireDate(row.usage_date)))].sort(
		compareStrings,
	);
}

function sum(rows: readonly RawDatabaseRow[], field: string): number {
	return rows.reduce((total, row) => total + numberValue(row[field]), 0);
}

function numberValue(value: unknown): number {
	if (value == null || value === "") return 0;
	const number = Number(value);
	if (!Number.isFinite(number))
		throw new Error(`Expected numeric value, got ${String(value)}`);
	return number;
}

function stringValue(value: unknown, fallback: string): string {
	return value == null || value === "" ? fallback : String(value);
}

function requireString(value: unknown, field: string): string {
	if (value == null || value === "")
		throw new Error(`Missing required ${field}`);
	return String(value);
}

function requireDate(value: unknown): string {
	const date = requireString(value, "usage_date");
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
		throw new Error(`Invalid usage_date: ${date}`);
	const [year, month, day] = date.split("-").map(Number);
	const timestamp = Date.UTC(year, month - 1, day);
	const parsed = new Date(timestamp);
	if (
		parsed.getUTCFullYear() !== year ||
		parsed.getUTCMonth() !== month - 1 ||
		parsed.getUTCDate() !== day
	) {
		throw new Error(`Invalid usage_date: ${date}`);
	}
	return date;
}

function minDate(current: string | null, candidate: string): string | null {
	if (!candidate) return current;
	return current == null || candidate < current ? candidate : current;
}

function maxDate(current: string | null, candidate: string): string | null {
	if (!candidate) return current;
	return current == null || candidate > current ? candidate : current;
}

function nextDate(date: string): string {
	const [year, month, day] = date.split("-").map(Number);
	return new Date(Date.UTC(year, month - 1, day + 1))
		.toISOString()
		.slice(0, 10);
}

function roundUsd(value: number): number {
	return Math.round(value * 10000) / 10000;
}

function sqlValueForBreakdown(row: BreakdownRow, column: string): string {
	const nullableColumns = new Set([
		"project_display",
		"project_alias",
		"pricing_version",
		"extra_metrics_json",
		"source_meta_json",
	]);
	const value = row[column];
	if (value == null && nullableColumns.has(column)) return "NULL";
	if (value == null)
		throw new Error(`Missing required breakdown column: ${column}`);
	if (typeof value === "number") return sqlNumber(value);
	if (typeof value === "boolean") return value ? "1" : "0";
	if (
		column === "event_count" ||
		column === "session_count" ||
		column.endsWith("_tokens") ||
		column === "estimated_cost_usd"
	) {
		return sqlNumber(numberValue(value));
	}
	return sqlString(String(value));
}

function sqlString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function sqlNumber(value: number): string {
	if (!Number.isFinite(value))
		throw new Error(`Cannot write non-finite SQL number: ${String(value)}`);
	return String(value);
}
