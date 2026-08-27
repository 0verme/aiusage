import { describe, expect, it } from "vitest";
import {
	buildAffectedDailyUsageSql,
	buildClaudeDiffReport,
	buildRestoreMissingClaudeSql,
	compressDateRanges,
	diffClaudeRows,
	isClaudeCodeProduct,
	selectClaudeRows,
	type ActivityRow,
	type BreakdownRow,
} from "./claude-recovery.js";

function breakdown(overrides: Partial<BreakdownRow> = {}): BreakdownRow {
	return {
		device_id: "device-a",
		usage_date: "2026-06-18",
		provider: "anthropic",
		product: "claude-code",
		channel: "cli",
		model: "claude-sonnet-4-6",
		project: "/work/project-a",
		project_display: "project-a",
		project_alias: null,
		event_count: 10,
		session_count: 2,
		input_tokens: 100,
		cached_input_tokens: 200,
		cache_write_tokens: 30,
		output_tokens: 40,
		reasoning_output_tokens: 5,
		estimated_cost_usd: 1.25,
		cost_status: "exact",
		pricing_version: "2026-08-12-v1",
		extra_metrics_json: '{"cache_write_5m_tokens":30}',
		source_meta_json: null,
		created_at: "2026-08-12T08:00:00.000Z",
		updated_at: "2026-08-12T08:00:00.000Z",
		...overrides,
	};
}

function activity(overrides: Partial<ActivityRow> = {}): ActivityRow {
	return {
		device_id: "device-a",
		usage_date: "2026-06-18",
		provider: "anthropic",
		product: "claude-code",
		source: "anthropic/claude-code",
		project: "/work/project-a",
		project_display: "project-a",
		project_alias: null,
		kind: "tool",
		name: "Read",
		confidence: "exact",
		event_count: 3,
		created_at: "2026-08-12T08:00:00.000Z",
		updated_at: "2026-08-12T08:00:00.000Z",
		...overrides,
	};
}

describe("Claude recovery dataset selection", () => {
	it("accepts historical product spellings but does not select other products by model name", () => {
		expect(isClaudeCodeProduct("claude-code")).toBe(true);
		expect(isClaudeCodeProduct("claude_code")).toBe(true);
		expect(isClaudeCodeProduct("claude-code-v2")).toBe(true);
		expect(isClaudeCodeProduct("claude-api")).toBe(false);
		expect(isClaudeCodeProduct("opencode")).toBe(false);
		expect(isClaudeCodeProduct("legacy-cli", ["legacy-cli"])).toBe(true);
	});

	it("includes Claude Code rows from any provider", () => {
		const rows = selectClaudeRows([
			breakdown({ provider: "anthropic" }),
			breakdown({ provider: "deepseek" }),
			breakdown({
				provider: "openai",
				product: "opencode",
				model: "claude-sonnet-4-6",
			}),
		]);

		expect(rows.map((row) => row.provider)).toEqual(["anthropic", "deepseek"]);
		expect(diffClaudeRows(rows, []).missing.map((row) => row.provider)).toEqual(
			["anthropic", "deepseek"],
		);
	});

	it("rejects duplicate unique keys instead of silently changing the diff", () => {
		expect(() => diffClaudeRows([breakdown(), breakdown()], [])).toThrow(
			/Duplicate historical Claude row/,
		);
	});

	it("treats E:\\foo and e:\\foo as distinct SQLite primary keys", () => {
		const upper = breakdown({ project: String.raw`E:\foo` });
		const lower = breakdown({ project: String.raw`e:\foo` });
		const diff = diffClaudeRows([upper, lower], [upper]);

		expect(diff.missing).toHaveLength(1);
		expect(diff.missing[0].project).toBe(lower.project);
		expect(diff.conflicts).toHaveLength(0);
	});
});

describe("Claude recovery diff", () => {
	it("computes missing, conflict, current-only, ranges, daily status, and affected days", () => {
		const historical = [
			breakdown({ usage_date: "2026-06-13", project: "/work/ok" }),
			breakdown({ usage_date: "2026-06-18", project: "/work/missing" }),
			breakdown({ usage_date: "2026-06-18", project: "/work/conflict" }),
			breakdown({ usage_date: "2026-06-19", project: "/work/gone" }),
		];
		const current = [
			breakdown({ usage_date: "2026-06-13", project: "/work/ok" }),
			breakdown({
				usage_date: "2026-06-18",
				project: "/work/conflict",
				output_tokens: 41,
			}),
			breakdown({ usage_date: "2026-06-20", project: "/work/new" }),
		];
		const report = buildClaudeDiffReport({
			historicalRows: historical,
			currentRows: current,
			historicalActivityRows: [],
			currentActivityRows: [],
			claudeProducts: ["claude-code"],
			generatedAt: "2026-08-27T01:00:00.000Z",
		});

		expect(report.missingRows).toHaveLength(2);
		expect(report.conflicts).toHaveLength(1);
		expect(report.conflicts[0].differences).toEqual([
			{ field: "output_tokens", historical: 40, current: 41 },
		]);
		expect(report.currentOnlyRows).toHaveLength(1);
		expect(report.missingDates).toEqual(["2026-06-18", "2026-06-19"]);
		expect(report.missingDateRanges).toEqual(["2026-06-18 ~ 2026-06-19"]);
		expect(report.affectedDays).toEqual([
			{ device_id: "device-a", usage_date: "2026-06-18" },
			{ device_id: "device-a", usage_date: "2026-06-19" },
		]);
		expect(report.daily).toEqual([
			expect.objectContaining({
				date: "2026-06-13",
				status: "OK",
				conflictRows: 0,
			}),
			expect.objectContaining({
				date: "2026-06-18",
				status: "PARTIAL",
				missingRows: 1,
				conflictRows: 1,
			}),
			expect.objectContaining({
				date: "2026-06-19",
				status: "MISSING",
				missingRows: 1,
			}),
			expect.objectContaining({
				date: "2026-06-20",
				status: "OK",
				currentOnlyRows: 1,
			}),
		]);
		expect(report.missingSummary).toMatchObject({
			rows: 2,
			events: 20,
			sessions: 4,
			inputTokens: 200,
			cachedInputTokens: 400,
			cacheWriteTokens: 60,
			outputTokens: 80,
			reasoningTokens: 10,
			estimatedCostUsd: 2.5,
		});
		expect(report.missingByProject.map((row) => row.group)).toEqual([
			"/work/gone",
			"/work/missing",
		]);
	});

	it("compresses multiple non-contiguous date ranges", () => {
		expect(
			compressDateRanges([
				"2026-06-21",
				"2026-06-13",
				"2026-06-14",
				"2026-06-18",
				"2026-06-20",
			]),
		).toEqual([
			{ from: "2026-06-13", to: "2026-06-14" },
			{ from: "2026-06-18", to: "2026-06-18" },
			{ from: "2026-06-20", to: "2026-06-21" },
		]);
	});
});

describe("Claude recovery activity diff", () => {
	it("audits activity independently without producing activity recovery SQL", () => {
		const report = buildClaudeDiffReport({
			historicalRows: [],
			currentRows: [],
			historicalActivityRows: [activity(), activity({ name: "Edit" })],
			currentActivityRows: [activity({ event_count: 4 })],
			claudeProducts: ["claude-code"],
		});

		expect(report.activity.missingRows).toHaveLength(1);
		expect(report.activity.missingEvents).toBe(3);
		expect(report.activity.conflicts).toHaveLength(1);
		expect(report.activity.conflicts[0].differences).toEqual([
			{ field: "event_count", historical: 3, current: 4 },
		]);
		expect(report.activity.missingDateRanges).toEqual(["2026-06-18"]);
	});
});

describe("Claude recovery SQL", () => {
	it("generates only full-field INSERT ... DO NOTHING statements for missing rows", () => {
		const sql = buildRestoreMissingClaudeSql(
			[breakdown({ project: "O'Reilly" })],
			{
				generatedAt: "2026-08-27T01:00:00.000Z",
			},
		);

		expect(sql).toContain("INSERT INTO daily_usage_breakdown");
		expect(sql).toContain("source_meta_json");
		expect(sql).toContain("'O''Reilly'");
		expect(sql).toContain(
			"ON CONFLICT (device_id, usage_date, provider, product, channel, model, project)",
		);
		expect(sql).toContain("DO NOTHING;");
		expect(sql).not.toMatch(/UPDATE daily_usage_breakdown/i);
		expect(sql).not.toMatch(/DELETE FROM daily_usage_breakdown/i);
	});

	it("generates INSERT only for MISSING and preserves CONFLICT/CURRENT_ONLY", () => {
		const historical = [
			breakdown({ project: "/work/missing" }),
			breakdown({ project: "/work/conflict", output_tokens: 40 }),
		];
		const current = [
			breakdown({ project: "/work/conflict", output_tokens: 41 }),
			breakdown({ project: "/work/current-only" }),
		];
		const report = buildClaudeDiffReport({
			historicalRows: historical,
			currentRows: current,
			historicalActivityRows: [],
			currentActivityRows: [],
			claudeProducts: ["claude-code"],
		});
		const sql = buildRestoreMissingClaudeSql(report.missingRows);

		expect(report.missingRows.map((row) => row.project)).toEqual([
			"/work/missing",
		]);
		expect(sql).toContain("'/work/missing'");
		expect(sql).not.toContain("'/work/conflict'");
		expect(sql).not.toContain("'/work/current-only'");
		expect(sql).not.toMatch(/^\s*(?:UPDATE|REPLACE|DELETE)\b/im);
	});

	it("recalculates only affected daily_usage pairs from breakdown sums", () => {
		const sql = buildAffectedDailyUsageSql(
			[
				{ device_id: "device-b", usage_date: "2026-06-21" },
				{ device_id: "device-a", usage_date: "2026-06-18" },
			],
			"2026-08-27-v1",
			"2026-08-27T01:00:00.000Z",
		);

		expect(sql.match(/UPDATE daily_usage\n/g) ?? []).toHaveLength(2);
		expect(sql).toContain(
			"SELECT SUM(input_tokens) FROM daily_usage_breakdown",
		);
		expect(sql).toContain(
			"SELECT SUM(cached_input_tokens) FROM daily_usage_breakdown",
		);
		expect(sql).toContain(
			"SELECT SUM(cache_write_tokens) FROM daily_usage_breakdown",
		);
		expect(sql).toContain(
			"SELECT SUM(output_tokens) FROM daily_usage_breakdown",
		);
		expect(sql).toContain(
			"SELECT SUM(reasoning_output_tokens) FROM daily_usage_breakdown",
		);
		expect(sql).toContain("estimated_cost_usd = ROUND(COALESCE");
		expect(sql).toContain("cost_status = 'unavailable'");
		expect(sql).toContain("cost_status = 'estimated'");
		expect(sql).toContain("pricing_version = '2026-08-27-v1'");
		expect(sql).toContain("COALESCE(project_alias, project_display)");
		expect(sql).toContain("GROUP BY model");
		expect(sql).toContain(
			"WHERE device_id = 'device-a' AND usage_date = '2026-06-18'",
		);
		expect(sql).not.toContain("DELETE FROM");
	});

	it("round-trips Chinese project values and Windows paths through UTF-8 SQL", () => {
		const values = [
			"AI生成代码-130df189",
			"个人品牌网站-5941f682",
			String.raw`E:\AI生成代码\aiusage`,
		];
		const sql = buildRestoreMissingClaudeSql(
			values.map((project) => breakdown({ project, project_display: project })),
		);
		const readBack = Buffer.from(sql, "utf8").toString("utf8");

		for (const value of values) {
			expect(readBack).toContain(`'${value}'`);
		}
		expect(readBack).toBe(sql);
	});
});
