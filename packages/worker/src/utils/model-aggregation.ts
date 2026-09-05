import { canonicalizeModel, displayModelName } from "@aiusage/shared";

export interface ModelAggregationRow {
	model?: string | null;
	rawModels?: string | readonly string[] | null;
	estimatedCostUsd?: number | null;
	eventCount?: number | null;
	totalTokens?: number | null;
}

export interface CanonicalModelAggregate {
	value: string;
	displayName: string;
	estimatedCostUsd: number;
	eventCount: number;
	totalTokens: number;
	rawModels: string[];
	aliasCount?: number;
}

/**
 * 将数据库模型维度映射到展示维度；pricing cost 已在调用前完成，不能在此重算。
 */
export function canonicalModelValue(
	model: string | null | undefined,
	mergeModelAliases = true,
): string {
	if (!mergeModelAliases) return model || "unknown";
	return canonicalizeModel(model);
}

export function parseRawModelValues(
	rawModels: string | readonly string[] | null | undefined,
	fallback: string | null | undefined,
): string[] {
	const values: readonly string[] = typeof rawModels === "string"
		? rawModels.split(",")
		: (rawModels ?? []);
	const parsed = values
		.map((value) => value.trim())
		.filter(Boolean);
	if (parsed.length === 0 && fallback) parsed.push(fallback);
	return [...new Set(parsed)].sort((left, right) => left.localeCompare(right));
}

/**
 * 在 D1 先按 pricing-compatible b.model 聚合后，在 Worker 内完成 canonical merge。
 * 所有金额、事件和 token 都只做 SUM，不重新查价或计算费用。
 */
export function mergeCanonicalModelRows(
	rows: readonly ModelAggregationRow[],
	mergeModelAliases = true,
): CanonicalModelAggregate[] {
	const merged = new Map<
		string,
		{
			estimatedCostUsd: number;
			eventCount: number;
			totalTokens: number;
			rawModels: Set<string>;
		}
	>();

	for (const row of rows) {
		const value = canonicalModelValue(row.model, mergeModelAliases);
		const existing = merged.get(value);
		const target = existing ?? {
			estimatedCostUsd: 0,
			eventCount: 0,
			totalTokens: 0,
			rawModels: new Set<string>(),
		};
		target.estimatedCostUsd += Number(row.estimatedCostUsd ?? 0);
		target.eventCount += Number(row.eventCount ?? 0);
		target.totalTokens += Number(row.totalTokens ?? 0);
		for (const rawModel of parseRawModelValues(row.rawModels, row.model)) {
			target.rawModels.add(rawModel);
		}
		merged.set(value, target);
	}

	return [...merged.entries()]
		.map(([value, row]) => {
			const rawModels = [...row.rawModels].sort((left, right) => left.localeCompare(right));
			return {
				value,
				displayName: mergeModelAliases ? displayModelName(value) : value,
				estimatedCostUsd: row.estimatedCostUsd,
				eventCount: row.eventCount,
				totalTokens: row.totalTokens,
				rawModels,
				...(mergeModelAliases && rawModels.length > 1
					? { aliasCount: rawModels.length }
					: {}),
			};
		})
		.sort(
			(left, right) =>
				right.totalTokens - left.totalTokens ||
				right.estimatedCostUsd - left.estimatedCostUsd ||
				left.value.localeCompare(right.value),
		);
}

/**
 * 从有限的数据库 distinct model 值中解析 canonical filter 对应的 raw 值。
 * 这样 filter 不需要在 SQL 中展开 canonical CASE，也不会漏掉历史 alias。
 */
export function selectCanonicalModelValues(
	rawModels: readonly (string | null | undefined)[],
	requestedModels: readonly string[],
): string[] {
	const requested = new Set(requestedModels.map((model) => canonicalizeModel(model)));
	return [
		...new Set(
			rawModels
				.filter((model): model is string => Boolean(model))
				.filter((model) => requested.has(canonicalizeModel(model))),
		),
	].sort((left, right) => left.localeCompare(right));
}
