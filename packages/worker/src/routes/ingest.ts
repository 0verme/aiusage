import {
	canonicalModelSqlExpression,
	canonicalizeProvider,
	type CostStatus,
	type IngestActivityItem,
	type IngestBreakdown,
	type IngestPayload,
} from "@aiusage/shared";
import { jsonNoStore, jsonError } from "../utils/response.js";
import { verifyDeviceToken } from "../utils/token.js";
import {
	calculateIngestBreakdownCost,
	getWorstCostStatus,
	PRICING_VERSION,
} from "../utils/pricing.js";
import type { Env } from "../types.js";

const MODEL_SQL = canonicalModelSqlExpression("b.model");

interface PreparedBreakdown {
	breakdown: IngestBreakdown;
	cost: ReturnType<typeof calculateIngestBreakdownCost>;
	cacheWrite5mTokens: number;
	cacheWrite1hTokens: number;
	rawProviders: Set<string>;
	rawModels: Set<string>;
}

/** 服务端落库前统一 provider，防御旧版 CLI 上传 alias。 */
export function canonicalizeIngestBreakdown(
	breakdown: IngestBreakdown,
): IngestBreakdown {
	return {
		...breakdown,
		provider: canonicalizeProvider({
			provider: breakdown.provider,
			product: breakdown.product,
			model: breakdown.rawModel?.trim() || breakdown.model?.trim() || "unknown",
		}),
	};
}

function normalizeRawProvider(provider?: string | null): string {
	const value = provider?.trim().toLowerCase() ?? "";
	return value || "unknown";
}

function mergePreparedBreakdown(
	target: PreparedBreakdown,
	incoming: PreparedBreakdown,
): void {
	const current = target.breakdown;
	const next = incoming.breakdown;
	current.eventCount += next.eventCount;
	current.sessionCount = (current.sessionCount ?? 0) + (next.sessionCount ?? 0);
	current.inputTokens += next.inputTokens;
	current.cachedInputTokens += next.cachedInputTokens;
	current.cacheWriteTokens += next.cacheWriteTokens;
	current.cacheWrite5mTokens =
		(current.cacheWrite5mTokens ?? 0) + (next.cacheWrite5mTokens ?? 0);
	current.cacheWrite1hTokens =
		(current.cacheWrite1hTokens ?? 0) + (next.cacheWrite1hTokens ?? 0);
	current.outputTokens += next.outputTokens;
	current.reasoningOutputTokens += next.reasoningOutputTokens;
	if (current.costUSD != null || next.costUSD != null) {
		current.costUSD = (current.costUSD ?? 0) + (next.costUSD ?? 0);
	}

	target.cacheWrite5mTokens += incoming.cacheWrite5mTokens;
	target.cacheWrite1hTokens += incoming.cacheWrite1hTokens;
	target.cost = {
		...target.cost,
		estimatedCostUsd:
			Math.round(
				(target.cost.estimatedCostUsd + incoming.cost.estimatedCostUsd) * 10000,
			) / 10000,
		costStatus: getWorstCostStatus([
			target.cost.costStatus,
			incoming.cost.costStatus,
		]),
	};
	for (const provider of incoming.rawProviders)
		target.rawProviders.add(provider);
	for (const model of incoming.rawModels) target.rawModels.add(model);
}

export async function handleIngest(
	request: Request,
	env: Env,
): Promise<Response> {
	// 校验 DEVICE_TOKEN
	const auth = request.headers.get("Authorization")?.replace("Bearer ", "");
	if (!auth) return jsonError(401, "INVALID_TOKEN", "Missing authorization");

	const tokenPayload = await verifyDeviceToken(auth, env.DEVICE_TOKEN_SECRET);
	if (!tokenPayload)
		return jsonError(401, "INVALID_TOKEN", "Invalid device token");

	const body = await request.json<IngestPayload>();

	// 校验一致性
	if (body.siteId !== tokenPayload.siteId) {
		return jsonError(403, "SITE_ID_MISMATCH", "Site ID mismatch");
	}
	if (body.device.deviceId !== tokenPayload.deviceId) {
		return jsonError(403, "DEVICE_ID_MISMATCH", "Device ID mismatch");
	}

	// 校验设备状态与 token_version
	const device = await env.DB.prepare(
		"SELECT status, token_version FROM devices WHERE device_id = ?",
	)
		.bind(tokenPayload.deviceId)
		.first<{ status: string; token_version: number }>();

	if (!device) return jsonError(401, "INVALID_TOKEN", "Device not found");
	if (device.status !== "active")
		return jsonError(403, "DEVICE_DISABLED", "Device has been disabled");
	if (device.token_version !== tokenPayload.tokenVersion) {
		return jsonError(401, "TOKEN_VERSION_MISMATCH", "Token version mismatch");
	}

	const now = new Date().toISOString();
	const costSummary: Record<
		string,
		{ estimatedCostUsd: number; costStatus: CostStatus }
	> = {};

	for (const day of body.days) {
		const costStatuses: CostStatus[] = [];
		const breakdownsByKey = new Map<string, PreparedBreakdown>();
		let dayTotalCost = 0;
		let dayTotalEvents = 0;
		let dayTotalInput = 0;
		let dayTotalCachedInput = 0;
		let dayTotalCacheWrite = 0;
		let dayTotalOutput = 0;
		let dayTotalReasoning = 0;

		// 按 breakdown 写入
		for (const b of day.breakdowns) {
			const cacheWrite5mTokens = b.cacheWrite5mTokens ?? b.cacheWriteTokens;
			const cacheWrite1hTokens = b.cacheWrite1hTokens ?? 0;
			// 优先采用 scanner 侧按 event 精确累计的 costUSD（GPT-5.6 长上下文档）
			const legacyModel = b.model?.trim() || "unknown";
			const rawModel = b.rawModel?.trim() || legacyModel;
			const pricingModelKey = b.pricingModelKey?.trim() || legacyModel;
			const cost = calculateIngestBreakdownCost({
				...b,
				model: pricingModelKey,
				pricingModelKey,
			});
			const canonicalBreakdown = canonicalizeIngestBreakdown({
				...b,
				// Keep the legacy model field pricing-compatible. If a newer client
				// sends raw model + pricing key separately, the key is the storage
				// dimension and the exact raw value is retained in extra_metrics_json.
				model: pricingModelKey,
				rawModel,
				pricingModelKey,
				project: b.project || "unknown",
			});
			const key = [
				canonicalBreakdown.provider,
				canonicalBreakdown.product,
				canonicalBreakdown.channel,
				canonicalBreakdown.model,
				canonicalBreakdown.pricingModelKey,
				canonicalBreakdown.project,
			].join("\0");
			const existing = breakdownsByKey.get(key);

			costStatuses.push(cost.costStatus);
			dayTotalCost += cost.estimatedCostUsd;
			dayTotalEvents += b.eventCount;
			dayTotalInput += b.inputTokens;
			dayTotalCachedInput += b.cachedInputTokens;
			dayTotalCacheWrite += b.cacheWriteTokens;
			dayTotalOutput += b.outputTokens;
			dayTotalReasoning += b.reasoningOutputTokens;

			if (existing) {
				mergePreparedBreakdown(existing, {
					breakdown: canonicalBreakdown,
					cost,
					cacheWrite5mTokens,
					cacheWrite1hTokens,
					rawProviders: new Set([normalizeRawProvider(b.provider)]),
					rawModels: new Set([rawModel]),
				});
			} else {
				breakdownsByKey.set(key, {
					breakdown: canonicalBreakdown,
					cost,
					cacheWrite5mTokens,
					cacheWrite1hTokens,
					rawProviders: new Set([normalizeRawProvider(b.provider)]),
					rawModels: new Set([rawModel]),
				});
			}
		}

		const dayCostStatus = getWorstCostStatus(costStatuses);

		// 先写入父记录，避免 breakdown 外键约束失败
		await env.DB.prepare(`
      INSERT INTO daily_usage
        (device_id, usage_date, event_count, input_tokens, cached_input_tokens,
         cache_write_tokens, output_tokens, reasoning_output_tokens,
         estimated_cost_usd, cost_status, pricing_version,
         top_project_by_cost, top_project_cost_usd, top_model_by_cost, top_model_cost_usd,
         created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (device_id, usage_date)
      DO UPDATE SET
        event_count = excluded.event_count,
        input_tokens = excluded.input_tokens,
        cached_input_tokens = excluded.cached_input_tokens,
        cache_write_tokens = excluded.cache_write_tokens,
        output_tokens = excluded.output_tokens,
        reasoning_output_tokens = excluded.reasoning_output_tokens,
        estimated_cost_usd = excluded.estimated_cost_usd,
        cost_status = excluded.cost_status,
        pricing_version = excluded.pricing_version,
        top_project_by_cost = excluded.top_project_by_cost,
        top_project_cost_usd = excluded.top_project_cost_usd,
        top_model_by_cost = excluded.top_model_by_cost,
        top_model_cost_usd = excluded.top_model_cost_usd,
        updated_at = excluded.updated_at
    `)
			.bind(
				tokenPayload.deviceId,
				day.usageDate,
				dayTotalEvents,
				dayTotalInput,
				dayTotalCachedInput,
				dayTotalCacheWrite,
				dayTotalOutput,
				dayTotalReasoning,
				Math.round(dayTotalCost * 10000) / 10000,
				dayCostStatus,
				PRICING_VERSION,
				"pending",
				0,
				"pending",
				0,
				now,
				now,
			)
			.run();

		// Replace all breakdowns for this device/day so project renames (e.g. home → Other)
		// do not leave orphan rows that still appear in Sankey.
		await env.DB.prepare(`
      DELETE FROM daily_usage_breakdown
      WHERE device_id = ? AND usage_date = ?
    `)
			.bind(tokenPayload.deviceId, day.usageDate)
			.run();

		for (const {
			breakdown: b,
			cost,
			cacheWrite5mTokens,
			cacheWrite1hTokens,
			rawProviders,
			rawModels,
		} of breakdownsByKey.values()) {
			const rawProject = b.project || "unknown";
			const extraMetrics: Record<string, unknown> = {
				cache_write_5m_tokens: cacheWrite5mTokens,
				cache_write_1h_tokens: cacheWrite1hTokens,
			};
			const rawModelList = [...rawModels]
				.filter(Boolean)
				.sort((left, right) => left.localeCompare(right));
			if (rawModelList.some((rawModel) => rawModel !== b.model)) {
				extraMetrics.raw_models = rawModelList;
				extraMetrics.raw_model = rawModelList[0];
			}
			if (b.pricingModelKey && b.pricingModelKey !== b.model) {
				extraMetrics.pricing_model_key = b.pricingModelKey;
			}
			const rawProviderList = [...rawProviders];
			if (rawProviderList.some((provider) => provider !== b.provider)) {
				extraMetrics.raw_providers = rawProviderList;
			}
			const isFullPath =
				rawProject.startsWith("/") || /^[A-Z]:\\/i.test(rawProject);
			const projectDisplay =
				b.projectDisplay ??
				(isFullPath
					? rawProject.split("/").filter(Boolean).pop() || "unknown"
					: rawProject);
			const projectAlias = b.projectAlias ?? null;

			await env.DB.prepare(`
        INSERT INTO daily_usage_breakdown
          (device_id, usage_date, provider, product, channel, model, project,
           project_display, project_alias,
           event_count, session_count, input_tokens, cached_input_tokens, cache_write_tokens,
           output_tokens, reasoning_output_tokens, estimated_cost_usd, cost_status,
           pricing_version, extra_metrics_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (device_id, usage_date, provider, product, channel, model, project)
        DO UPDATE SET
          project_display = excluded.project_display,
          project_alias = excluded.project_alias,
          event_count = excluded.event_count,
          session_count = excluded.session_count,
          input_tokens = excluded.input_tokens,
          cached_input_tokens = excluded.cached_input_tokens,
          cache_write_tokens = excluded.cache_write_tokens,
          output_tokens = excluded.output_tokens,
          reasoning_output_tokens = excluded.reasoning_output_tokens,
          estimated_cost_usd = excluded.estimated_cost_usd,
          cost_status = excluded.cost_status,
          pricing_version = excluded.pricing_version,
          extra_metrics_json = excluded.extra_metrics_json,
          updated_at = excluded.updated_at
      `)
				.bind(
					tokenPayload.deviceId,
					day.usageDate,
					b.provider,
					b.product,
					b.channel,
					b.model || "unknown",
					rawProject,
					projectDisplay,
					projectAlias,
					b.eventCount,
					b.sessionCount ?? 0,
					b.inputTokens,
					b.cachedInputTokens,
					b.cacheWriteTokens,
					b.outputTokens,
					b.reasoningOutputTokens,
					cost.estimatedCostUsd,
					cost.costStatus,
					cost.pricingVersion,
					JSON.stringify(extraMetrics),
					now,
					now,
				)
				.run();
		}

		await replaceActivityMetrics(
			env,
			tokenPayload.deviceId,
			day.usageDate,
			day.activity?.items ?? [],
			now,
		);

		// 计算 top project / model 并回填 daily_usage
		const topProject = await env.DB.prepare(`
      SELECT COALESCE(project_alias, project_display) as project, SUM(estimated_cost_usd) as total_cost
      FROM daily_usage_breakdown
      WHERE device_id = ? AND usage_date = ?
      GROUP BY COALESCE(project_alias, project_display) ORDER BY total_cost DESC LIMIT 1
    `)
			.bind(tokenPayload.deviceId, day.usageDate)
			.first<{ project: string; total_cost: number }>();

		const topModel = await env.DB.prepare(`
      SELECT ${MODEL_SQL} AS model, SUM(estimated_cost_usd) as total_cost
      FROM daily_usage_breakdown b
      WHERE b.device_id = ? AND b.usage_date = ?
      GROUP BY ${MODEL_SQL} ORDER BY total_cost DESC LIMIT 1
    `)
			.bind(tokenPayload.deviceId, day.usageDate)
			.first<{ model: string; total_cost: number }>();

		await env.DB.prepare(`
      UPDATE daily_usage
      SET top_project_by_cost = ?, top_project_cost_usd = ?,
          top_model_by_cost = ?, top_model_cost_usd = ?,
          updated_at = ?
      WHERE device_id = ? AND usage_date = ?
    `)
			.bind(
				topProject?.project ?? "unknown",
				topProject?.total_cost ?? 0,
				topModel?.model ?? "unknown",
				topModel?.total_cost ?? 0,
				now,
				tokenPayload.deviceId,
				day.usageDate,
			)
			.run();

		costSummary[day.usageDate] = {
			estimatedCostUsd: Math.round(dayTotalCost * 10000) / 10000,
			costStatus: dayCostStatus,
		};
	}

	// 更新 last_seen_at + 别名（sync 时自动同步本地别名）
	await env.DB.prepare(
		"UPDATE devices SET last_seen_at = ?, app_version = ?, public_label = COALESCE(?, public_label) WHERE device_id = ?",
	)
		.bind(
			now,
			body.device.appVersion,
			body.device.deviceAlias ?? null,
			tokenPayload.deviceId,
		)
		.run();

	return jsonNoStore({ daysProcessed: body.days.length, costSummary });
}

export async function replaceActivityMetrics(
	env: Env,
	deviceId: string,
	usageDate: string,
	items: IngestActivityItem[],
	now: string,
): Promise<void> {
	try {
		await env.DB.prepare(
			"DELETE FROM daily_activity_breakdown WHERE device_id = ? AND usage_date = ?",
		)
			.bind(deviceId, usageDate)
			.run();

		for (const item of items) {
			const count = Math.max(0, Math.floor(Number(item.count ?? 0)));
			if (count === 0) continue;
			const provider = canonicalizeProvider({
				provider: item.provider,
				product: item.product,
			});
			const product = item.product || "unknown";
			const rawProject = item.project || "unknown";
			const isFullPath =
				rawProject.startsWith("/") || /^[A-Z]:\\/i.test(rawProject);
			const projectDisplay =
				item.projectDisplay ??
				(isFullPath
					? rawProject.split("/").filter(Boolean).pop() || "unknown"
					: rawProject);

			await env.DB.prepare(`
        INSERT INTO daily_activity_breakdown
          (device_id, usage_date, provider, product, source, project,
           project_display, project_alias, kind, name, confidence, event_count,
           created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
				.bind(
					deviceId,
					usageDate,
					provider,
					product,
					item.source || `${provider}/${product}`,
					rawProject,
					projectDisplay,
					item.projectAlias ?? null,
					item.kind || "unknown",
					item.name || "unknown",
					item.confidence === "proxy" ? "proxy" : "exact",
					count,
					now,
					now,
				)
				.run();
		}
	} catch (error) {
		if (String(error).includes("daily_activity_breakdown")) return;
		throw error;
	}
}
