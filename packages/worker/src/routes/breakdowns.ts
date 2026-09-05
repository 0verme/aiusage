import {
	canonicalProviderSqlExpression,
	canonicalizeModel,
	canonicalizeProvider,
	DEFAULT_BREAKDOWN_LIMIT,
	MAX_BREAKDOWN_LIMIT,
} from "@aiusage/shared";
import { CACHE_PRESETS, jsonCached, jsonError } from "../utils/response.js";
import {
	resolvePublicProjectFilter,
	toPublicProjectIdentity,
} from "../utils/privacy.js";
import { selectCanonicalModelValues } from "../utils/model-aggregation.js";
import { prepareDashboardQuery } from "../utils/sql.js";
import type { Env } from "../types.js";

const PROVIDER_SQL = canonicalProviderSqlExpression("b.provider", "b.model");
const RAW_MODEL_SQL = `COALESCE(
  CASE WHEN json_valid(b.extra_metrics_json)
    THEN json_extract(b.extra_metrics_json, '$.raw_model')
  END,
  b.model
)`;

const SORT_FIELDS: Record<string, string> = {
	usage_date: "b.usage_date",
	device_id: "b.device_id",
	provider: PROVIDER_SQL,
	product: "b.product",
	channel: "b.channel",
	model: "b.model",
	project: "COALESCE(b.project_alias, b.project_display)",
	event_count: "b.event_count",
	input_tokens: "b.input_tokens",
	cached_input_tokens: "b.cached_input_tokens",
	cache_write_tokens: "b.cache_write_tokens",
	output_tokens: "b.output_tokens",
	reasoning_output_tokens: "b.reasoning_output_tokens",
	estimated_cost_usd: "b.estimated_cost_usd",
	total_tokens: `
    COALESCE(b.input_tokens, 0) +
    COALESCE(b.cached_input_tokens, 0) +
    COALESCE(b.cache_write_tokens, 0) +
    COALESCE(b.output_tokens, 0) +
    COALESCE(b.reasoning_output_tokens, 0)
  `,
};

export function buildBreakdownQuery(
	whereClause: string,
	mergeModelAliases = true,
	sort = "estimated_cost_usd",
	order: "ASC" | "DESC" = "DESC",
): string {
	const modelExpression = mergeModelAliases ? "b.model" : RAW_MODEL_SQL;
	const sortExpression = sort === "model" && !mergeModelAliases
		? RAW_MODEL_SQL
		: SORT_FIELDS[sort] ?? SORT_FIELDS.estimated_cost_usd;
	return `
    SELECT
      b.device_id,
      b.usage_date,
      ${PROVIDER_SQL} AS provider,
      b.product,
      b.channel,
      ${modelExpression} AS model,
      ${RAW_MODEL_SQL} AS raw_model,
      COALESCE(b.project_alias, b.project_display) AS project,
      b.event_count,
      b.input_tokens,
      b.cached_input_tokens,
      b.cache_write_tokens,
      b.output_tokens,
      b.reasoning_output_tokens,
      (${SORT_FIELDS.total_tokens}) AS total_tokens,
      b.estimated_cost_usd,
      b.cost_status
    FROM daily_usage_breakdown b
    ${whereClause}
    ORDER BY ${sortExpression} ${order}, b.usage_date DESC, b.estimated_cost_usd DESC
    LIMIT ? OFFSET ?
  `;
}

export async function handleBreakdowns(url: URL, env: Env): Promise<Response> {
	const range = url.searchParams.get("range") ?? "30d";
	const date = readTextParam(url, "date");
	const deviceId = readTextParam(url, "deviceId");
	const provider = readTextParam(url, "provider");
	const canonicalProvider = provider
		? canonicalizeProvider({ provider })
		: null;
	const product = readTextParam(url, "product");
	const requestedModel = readTextParam(url, "model");
	const channel = readTextParam(url, "channel");
	const project = readTextParam(url, "project");
	const mergeModelAliases = readBooleanParam(url, "mergeModelAliases", true);
	const modelExpression = mergeModelAliases ? "b.model" : RAW_MODEL_SQL;
	const projectFilter = await resolvePublicProjectFilter(
		project ? [project] : [],
		env,
	);
	const limit = clampLimit(url.searchParams.get("limit"));
	const offset = Math.max(
		0,
		parseInt(url.searchParams.get("offset") ?? "0", 10) || 0,
	);
	const sort = normalizeSort(url.searchParams.get("sort"));
	const order = normalizeOrder(url.searchParams.get("order"));

	const conditions: string[] = [];
	const params: (string | number)[] = [];

	if (date) {
		conditions.push("b.usage_date = ?");
		params.push(date);
	} else {
		const minDate = buildMinDate(range);
		if (minDate === undefined)
			return jsonError(400, "INVALID_PAYLOAD", "Invalid range parameter", true);
		if (minDate) {
			conditions.push("b.usage_date >= ?");
			params.push(minDate);
		}
	}

	if (deviceId) {
		conditions.push("b.device_id = ?");
		params.push(deviceId);
	}
	if (canonicalProvider) {
		conditions.push(`${PROVIDER_SQL} = ?`);
		params.push(canonicalProvider);
	}
	if (product) {
		if (product === "trae") {
			conditions.push("b.product IN (?, ?, ?)");
			params.push("trae", "trae-cn", "trae-intl");
		} else {
			conditions.push("b.product = ?");
			params.push(product);
		}
	}
	const model = requestedModel
		? (mergeModelAliases ? canonicalizeModel(requestedModel) : requestedModel)
		: null;
	if (channel) {
		conditions.push("b.channel = ?");
		params.push(channel);
	}
	if (project && projectFilter.databaseValues.length > 0) {
		if (projectFilter.databaseValues.length === 1) {
			conditions.push("COALESCE(b.project_alias, b.project_display) = ?");
		} else {
			conditions.push(
				`COALESCE(b.project_alias, b.project_display) IN (${projectFilter.databaseValues.map(() => "?").join(", ")})`,
			);
		}
		params.push(...projectFilter.databaseValues);
	}

	if (model) {
		if (!mergeModelAliases) {
			conditions.push(`${modelExpression} = ?`);
			params.push(model);
		} else {
			const candidateWhere =
				conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
			const candidateRows = await prepareQuery(env, `
    SELECT DISTINCT b.model
    FROM daily_usage_breakdown b
    ${candidateWhere}
  `)
				.bind(...params)
				.all<{ model: string | null }>();
			const databaseValues = selectCanonicalModelValues(
				(candidateRows.results ?? []).map((row) => row.model),
				[model],
			);
			if (databaseValues.length === 0) {
				conditions.push("1 = 0");
			} else {
				conditions.push(
					databaseValues.length === 1
						? "b.model = ?"
						: `b.model IN (${databaseValues.map(() => "?").join(", ")})`,
				);
				params.push(...databaseValues);
			}
		}
	}

	const whereClause =
		conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
	const countResult = await prepareQuery(env, `
    SELECT COUNT(*) AS total
    FROM daily_usage_breakdown b
    ${whereClause}
  `)
		.bind(...params)
		.first<{ total: number }>();

	const rows = await prepareQuery(env, buildBreakdownQuery(
		whereClause,
		mergeModelAliases,
		sort,
		order,
	))
		.bind(...params, limit, offset)
		.all<{
			device_id: string;
			usage_date: string;
			provider: string;
			product: string;
			channel: string;
			model: string;
			raw_model: string;
			project: string;
			event_count: number;
			input_tokens: number;
			cached_input_tokens: number;
			cache_write_tokens: number;
			output_tokens: number;
			reasoning_output_tokens: number;
			total_tokens: number;
			estimated_cost_usd: number;
			cost_status: string;
		}>();

	const data = await Promise.all(
		(rows.results ?? []).map(async (row) => ({
			...row,
			model: mergeModelAliases ? canonicalizeModel(row.model) : row.model,
			raw_model: row.raw_model || row.model,
			provider: canonicalizeProvider({ provider: row.provider, model: row.raw_model || row.model }),
			estimated_cost_usd: roundUsd(row.estimated_cost_usd),
			total_tokens: Number(row.total_tokens ?? 0),
			project: (
				await toPublicProjectIdentity(String(row.project ?? "unknown"), env)
			).label,
		})),
	);

	const total = Number(countResult?.total ?? 0);

	return jsonCached(
		{
			data,
			pagination: {
				total,
				limit,
				offset,
				hasMore: offset + limit < total,
			},
			sort,
			order,
		},
		CACHE_PRESETS.trend,
		true,
	);
}

function prepareQuery(env: Env, sql: string) {
	return prepareDashboardQuery(env.DB, "breakdowns", sql);
}

function readTextParam(url: URL, key: string): string | null {
	const value = url.searchParams.get(key);
	if (!value) return null;
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

function readBooleanParam(url: URL, key: string, fallback: boolean): boolean {
	const value = readTextParam(url, key)?.toLowerCase();
	if (!value) return fallback;
	if (["0", "false", "off", "no"].includes(value)) return false;
	if (["1", "true", "on", "yes"].includes(value)) return true;
	return fallback;
}

function clampLimit(value: string | null): number {
	const parsed = parseInt(value ?? String(DEFAULT_BREAKDOWN_LIMIT), 10);
	if (Number.isNaN(parsed) || parsed <= 0) return DEFAULT_BREAKDOWN_LIMIT;
	return Math.min(parsed, MAX_BREAKDOWN_LIMIT);
}

function normalizeSort(value: string | null): string {
	if (!value) return "estimated_cost_usd";
	return SORT_FIELDS[value] ? value : "estimated_cost_usd";
}

function normalizeOrder(value: string | null): "ASC" | "DESC" {
	return value?.toLowerCase() === "asc" ? "ASC" : "DESC";
}

function roundUsd(value: number): number {
	return Math.round(Number(value || 0) * 10000) / 10000;
}

function buildMinDate(range: string): string | null | undefined {
	if (range === "all") return null;

	const now = new Date();
	let days: number;
	if (range === "7d") days = 7;
	else if (range === "30d") days = 30;
	else if (range === "3m" || range === "90d") days = 90;
	else if (range === "6m" || range === "180d") days = 180;
	else return undefined;

	const min = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
	return min.toISOString().split("T")[0];
}
