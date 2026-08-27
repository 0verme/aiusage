import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getPricingCatalog } from "@aiusage/shared";
import {
	buildAffectedDailyUsageSql,
	buildClaudeDiffReport,
	buildRestoreMissingClaudeSql,
	selectClaudeRows,
	summarizeProductPairs,
	type ActivityRow,
	type AffectedDay,
	type BreakdownRow,
	type ClaudeDiffReport,
	type RawDatabaseRow,
} from "../src/maintenance/claude-recovery.js";

const execFileAsync = promisify(execFile);
const workerDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(workerDir, "..", "..");
const pnpmBin = "pnpm";
const wranglerScript = resolve(
	workerDir,
	"node_modules",
	"wrangler",
	"bin",
	"wrangler.js",
);
const DATABASE = "aiusage-db";

export const PRE_RESET_TIMESTAMP = "2026-08-12T16:54:43+08:00";
export const PRE_RESET_BOOKMARK =
	"00000141-00000deb-000050c5-efa5f6bfdde085cd2dc817e624582eaf";

const BREAKDOWN_QUERY = `
SELECT *
FROM daily_usage_breakdown
ORDER BY device_id, usage_date, provider, product, channel, model, project`;

const ACTIVITY_QUERY = `
SELECT *
FROM daily_activity_breakdown
ORDER BY device_id, usage_date, provider, product, source, project, kind, name, confidence`;

const PRODUCT_DISTRIBUTION_QUERY = `
SELECT provider, product, COUNT(*) AS rows, MIN(usage_date) AS first_date, MAX(usage_date) AS last_date
FROM daily_usage_breakdown
GROUP BY provider, product
ORDER BY first_date, provider, product`;

const ACTIVITY_DISTRIBUTION_QUERY = `
SELECT provider, product, COUNT(*) AS rows, MIN(usage_date) AS first_date, MAX(usage_date) AS last_date
FROM daily_activity_breakdown
GROUP BY provider, product
ORDER BY first_date, provider, product`;

const DAILY_KEYS_QUERY = `
SELECT device_id, usage_date
FROM daily_usage
ORDER BY device_id, usage_date`;
const QUERY_PAGE_SIZE = 500;

interface Options {
	remote: boolean;
	uploaderPaused: boolean;
	yes: boolean;
	outputDir?: string;
	preResetTimestamp: string;
	preResetBookmark: string;
	extraProducts: string[];
}

interface BookmarkArtifact {
	timestamp: string;
	bookmark: string;
	response: unknown;
}

interface BaselineValidation {
	status: "CURRENT STATE RESTORED" | "CURRENT STATE NOT RESTORED";
	expectedSha256: string;
	actualSha256: string | null;
	matches: boolean;
	baselineExport: string;
	restoredExport: string | null;
}

interface RecoveryMetadata {
	database: string;
	generatedAt: string;
	preResetTimestamp: string;
	preResetBookmark: string;
	currentBookmark: string;
	pricingVersion: string;
	undoBookmark: string | null;
	outputDir: string;
	baselineValidation: BaselineValidation;
	affectedDeviceDateCount: number;
	affectedDates: string[];
	missingDailyUsageParents: AffectedDay[];
	safeToExecuteInsertSql: boolean;
	sqlExecuted: false;
}

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	if (!options.remote) {
		throw new Error("必须显式指定 --remote；Time Travel 只允许操作远程 D1。");
	}
	if (!options.uploaderPaused) {
		throw new Error(
			"开始前必须确认 uploader 已暂停：请传入 --uploader-paused。",
		);
	}
	if (!options.yes) {
		throw new Error("Time Travel restore 是破坏性临时操作：请同时传入 --yes。");
	}

	const outputDir = resolve(options.outputDir ?? defaultOutputDir());
	await mkdir(outputDir, { recursive: true });
	const generatedAt = new Date().toISOString();
	const pricingVersion = getPricingCatalog().version;
	const currentExport = join(outputDir, "current-full-export.sql");
	const restoredCurrentExport = join(outputDir, "restored-current-export.sql");

	writeLog(`输出目录: ${outputDir}`);
	writeLog("Phase A/B: 导出当前完整数据库并读取全部 breakdown/activity...");
	await exportDatabase(currentExport);
	const currentBookmarkArtifact = await resolveBookmark(
		new Date().toISOString(),
	);
	await writeFile(
		join(outputDir, "CURRENT_BOOKMARK"),
		`${currentBookmarkArtifact.bookmark}\n`,
		"utf8",
	);
	await writeJson(
		join(outputDir, "current-bookmark.json"),
		currentBookmarkArtifact,
	);

	const [
		currentAllBreakdowns,
		currentAllActivity,
		currentDistribution,
		currentActivityDistribution,
		currentDailyKeys,
	] = await Promise.all([
		queryRows<BreakdownRow>(BREAKDOWN_QUERY),
		queryRows<ActivityRow>(ACTIVITY_QUERY),
		queryRows(PRODUCT_DISTRIBUTION_QUERY),
		queryRows(ACTIVITY_DISTRIBUTION_QUERY),
		queryRows<RawDatabaseRow>(DAILY_KEYS_QUERY),
	]);
	const currentClaudeRowsBeforeRestore = selectClaudeRows(
		currentAllBreakdowns,
		options.extraProducts,
	);
	const currentClaudeActivityRowsBeforeRestore = selectClaudeRows(
		currentAllActivity,
		options.extraProducts,
	);
	await writeJson(
		join(outputDir, "current-claude-all.json"),
		currentClaudeRowsBeforeRestore,
	);
	await writeJson(
		join(outputDir, "current-claude-activity-all.json"),
		currentClaudeActivityRowsBeforeRestore,
	);
	await writeJson(
		join(outputDir, "current-provider-product-distribution.json"),
		currentDistribution,
	);
	await writeJson(
		join(outputDir, "current-activity-provider-product-distribution.json"),
		currentActivityDistribution,
	);

	let temporaryRestoreStarted = false;
	let undoBookmark: string | null = null;
	let baselineValidation: BaselineValidation | null = null;

	try {
		writeLog(`Phase C: restore PRE_RESET ${options.preResetBookmark}...`);
		temporaryRestoreStarted = true;
		const restoreResponse = await restoreToBookmark(options.preResetBookmark);
		undoBookmark =
			findBookmark(restoreResponse) ?? currentBookmarkArtifact.bookmark;
		await writeFile(
			join(outputDir, "UNDO_BOOKMARK"),
			`${undoBookmark}\n`,
			"utf8",
		);
		await writeJson(join(outputDir, "undo-bookmark.json"), {
			bookmark: undoBookmark,
			response: restoreResponse,
			fallbackToCurrentBookmark: findBookmark(restoreResponse) == null,
		});

		writeLog("Phase D/E: 在历史状态读取全部 Claude breakdown/activity...");
		const [
			historicalAllBreakdowns,
			historicalAllActivity,
			historicalDistribution,
			historicalActivityDistribution,
		] = await Promise.all([
			queryRows<BreakdownRow>(BREAKDOWN_QUERY),
			queryRows<ActivityRow>(ACTIVITY_QUERY),
			queryRows(PRODUCT_DISTRIBUTION_QUERY),
			queryRows(ACTIVITY_DISTRIBUTION_QUERY),
		]);
		const historicalClaudeRows = selectClaudeRows(
			historicalAllBreakdowns,
			options.extraProducts,
		);
		const historicalClaudeActivityRows = selectClaudeRows(
			historicalAllActivity,
			options.extraProducts,
		);
		await writeJson(
			join(outputDir, "historical-claude-all.json"),
			historicalClaudeRows,
		);
		await writeJson(
			join(outputDir, "historical-claude-activity-all.json"),
			historicalClaudeActivityRows,
		);
		await writeJson(
			join(outputDir, "historical-provider-product-distribution.json"),
			historicalDistribution,
		);
		await writeJson(
			join(outputDir, "historical-activity-provider-product-distribution.json"),
			historicalActivityDistribution,
		);
	} finally {
		if (temporaryRestoreStarted) {
			writeLog("Phase F: restore current state immediately...");
			if (!undoBookmark) undoBookmark = currentBookmarkArtifact.bookmark;
			await restoreToBookmark(undoBookmark);
			await exportDatabase(restoredCurrentExport);
			baselineValidation = await validateBaseline(
				currentExport,
				restoredCurrentExport,
				outputDir,
			);
		}
	}

	if (!baselineValidation?.matches) {
		throw new Error(
			"CURRENT STATE RESTORED 校验失败；已停止离线分析和 SQL 生成。",
		);
	}

	writeLog("Phase G/N: 当前状态已验证恢复，开始离线差集分析...");
	const currentClaudeRows = await readJson<BreakdownRow[]>(
		join(outputDir, "current-claude-all.json"),
	);
	const historicalClaudeRows = await readJson<BreakdownRow[]>(
		join(outputDir, "historical-claude-all.json"),
	);
	const currentClaudeActivityRows = await readJson<ActivityRow[]>(
		join(outputDir, "current-claude-activity-all.json"),
	);
	const historicalClaudeActivityRows = await readJson<ActivityRow[]>(
		join(outputDir, "historical-claude-activity-all.json"),
	);
	const claudeProducts = [
		...new Set([
			...summarizeProductPairs(currentClaudeRows).map((pair) => pair.product),
			...summarizeProductPairs(historicalClaudeRows).map(
				(pair) => pair.product,
			),
		]),
	].sort(compareStrings);
	const report = buildClaudeDiffReport({
		historicalRows: historicalClaudeRows,
		currentRows: currentClaudeRows,
		historicalActivityRows: historicalClaudeActivityRows,
		currentActivityRows: currentClaudeActivityRows,
		claudeProducts,
		generatedAt,
	});
	const missingDailyUsageParents = report.affectedDays.filter(
		(day) =>
			!currentDailyKeys.some(
				(row) =>
					row.device_id === day.device_id && row.usage_date === day.usage_date,
			),
	);
	const metadata: RecoveryMetadata = {
		database: DATABASE,
		generatedAt,
		preResetTimestamp: options.preResetTimestamp,
		preResetBookmark: options.preResetBookmark,
		currentBookmark: currentBookmarkArtifact.bookmark,
		pricingVersion,
		undoBookmark,
		outputDir,
		baselineValidation,
		affectedDeviceDateCount: report.affectedDays.length,
		affectedDates: report.affectedDates,
		missingDailyUsageParents,
		safeToExecuteInsertSql:
			baselineValidation.matches && missingDailyUsageParents.length === 0,
		sqlExecuted: false,
	};

	await writeJson(join(outputDir, "claude-diff.json"), {
		...report,
		recovery: metadata,
	});
	await writeJson(
		join(outputDir, "historical-claude-coverage.json"),
		report.historicalCoverage,
	);
	await writeJson(
		join(outputDir, "current-claude-coverage.json"),
		report.currentCoverage,
	);
	await writeFile(
		join(outputDir, "restore-missing-claude.sql"),
		buildRestoreMissingClaudeSql(report.missingRows, { generatedAt }),
		"utf8",
	);
	await writeFile(
		join(outputDir, "recalculate-affected-daily-usage.sql"),
		buildAffectedDailyUsageSql(
			report.affectedDays,
			pricingVersion,
			generatedAt,
		),
		"utf8",
	);
	await writeFile(
		join(outputDir, "claude-recovery-report.md"),
		renderMarkdownReport(report, metadata),
		"utf8",
	);

	writeJsonOutput({
		...metadata,
		historical: report.historical,
		current: report.current,
		missing: report.missingSummary,
		missingDateRanges: report.missingDateRanges,
		conflicts: report.conflicts.length,
		currentOnly: report.currentOnlyRows.length,
		activity: {
			historical: report.activity.historical,
			current: report.activity.current,
			missingDates: report.activity.missingDateRanges,
			missingRows: report.activity.missingRows.length,
			missingEvents: report.activity.missingEvents,
		},
		generatedFiles: [
			"historical-claude-all.json",
			"current-claude-all.json",
			"historical-claude-activity-all.json",
			"current-claude-activity-all.json",
			"current-provider-product-distribution.json",
			"historical-provider-product-distribution.json",
			"current-activity-provider-product-distribution.json",
			"historical-activity-provider-product-distribution.json",
			"CURRENT_BOOKMARK",
			"UNDO_BOOKMARK",
			"current-full-export.sql",
			"restored-current-export.sql",
			"baseline-validation.json",
			"claude-diff.json",
			"historical-claude-coverage.json",
			"current-claude-coverage.json",
			"restore-missing-claude.sql",
			"recalculate-affected-daily-usage.sql",
			"claude-recovery-report.md",
		],
		stop: true,
	});
	writeLog(
		"STOP: 未执行 restore-missing-claude.sql，也未执行 daily_usage 重算 SQL；等待人工确认。",
	);
}

function parseOptions(args: string[]): Options {
	const options: Options = {
		remote: false,
		uploaderPaused: false,
		yes: false,
		preResetTimestamp: PRE_RESET_TIMESTAMP,
		preResetBookmark: PRE_RESET_BOOKMARK,
		extraProducts: [],
	};
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--remote") options.remote = true;
		else if (arg === "--uploader-paused") options.uploaderPaused = true;
		else if (arg === "--yes") options.yes = true;
		else if (arg === "--output-dir")
			options.outputDir = requiredArg(args[++index], arg);
		else if (arg === "--pre-reset-timestamp")
			options.preResetTimestamp = requiredArg(args[++index], arg);
		else if (arg === "--pre-reset-bookmark")
			options.preResetBookmark = requiredArg(args[++index], arg);
		else if (arg === "--claude-product")
			options.extraProducts.push(requiredArg(args[++index], arg));
		else if (arg === "--help" || arg === "-h") {
			printHelp();
			process.exit(0);
		} else {
			throw new Error(`未知参数: ${arg}`);
		}
	}
	if (
		!/^\d{4}-\d{2}-\d{2}T/.test(options.preResetTimestamp) ||
		Number.isNaN(Date.parse(options.preResetTimestamp))
	) {
		throw new Error("--pre-reset-timestamp 必须是有效 RFC3339 时间戳");
	}
	return options;
}

function requiredArg(value: string | undefined, flag: string): string {
	if (!value || value.startsWith("--")) throw new Error(`${flag} 需要一个值`);
	return value;
}

function defaultOutputDir(): string {
	const stamp = new Date()
		.toISOString()
		.replaceAll(/[-:.TZ]/g, "")
		.slice(0, 14);
	return resolve(repoRoot, "tmp", `d1-claude-recovery-${stamp}`);
}

async function queryRows<T = RawDatabaseRow>(sql: string): Promise<T[]> {
	const rows: T[] = [];
	let offset = 0;
	while (true) {
		const pageSql = `${sql.trim()} LIMIT ${QUERY_PAGE_SIZE} OFFSET ${offset}`;
		const payload = await runWranglerJson([
			"d1",
			"execute",
			DATABASE,
			"--remote",
			"--command",
			pageSql,
			"--json",
		]);
		const page = findResults<T>(payload);
		if (!page) throw new Error("D1 returned an envelope without results");
		rows.push(...page);
		if (page.length < QUERY_PAGE_SIZE) return rows;
		offset += QUERY_PAGE_SIZE;
	}
}

async function resolveBookmark(timestamp: string): Promise<BookmarkArtifact> {
	const response = await runWranglerJson([
		"d1",
		"time-travel",
		"info",
		DATABASE,
		"--timestamp",
		timestamp,
		"--json",
	]);
	const bookmark = findBookmark(response);
	if (!bookmark)
		throw new Error(
			`无法从 Time Travel info 响应提取 bookmark: ${JSON.stringify(response)}`,
		);
	return { timestamp, bookmark, response };
}

async function restoreToBookmark(bookmark: string): Promise<unknown> {
	return runWranglerJson([
		"d1",
		"time-travel",
		"restore",
		DATABASE,
		"--bookmark",
		bookmark,
		"--json",
	]);
}

async function exportDatabase(output: string): Promise<void> {
	await runWrangler([
		"d1",
		"export",
		DATABASE,
		"--remote",
		"--skip-confirmation",
		"--output",
		output,
	]);
}

async function runWrangler(args: string[]): Promise<string> {
	const command = process.platform === "win32" ? process.execPath : pnpmBin;
	const prefix =
		process.platform === "win32" ? [wranglerScript] : ["exec", "wrangler"];
	const result = await execFileAsync(command, [...prefix, ...args], {
		cwd: workerDir,
		maxBuffer: 128 * 1024 * 1024,
	});
	return result.stdout.trim();
}

async function runWranglerJson(args: string[]): Promise<unknown> {
	const stdout = await runWrangler(args);
	try {
		return JSON.parse(stripWranglerNoise(stdout)) as unknown;
	} catch (error) {
		throw new Error(
			`Wrangler returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function stripWranglerNoise(stdout: string): string {
	const starts = [stdout.indexOf("["), stdout.indexOf("{")].filter(
		(index) => index >= 0,
	);
	const start = starts.length > 0 ? Math.min(...starts) : -1;
	if (start < 0) throw new Error("Wrangler returned no JSON payload");
	return stdout.slice(start).trim();
}

function findResults<T>(value: unknown): T[] | null {
	if (Array.isArray(value)) {
		for (const item of value) {
			const result = findResults<T>(item);
			if (result) return result;
		}
		return null;
	}
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	if (Array.isArray(record.results)) return record.results as T[];
	for (const child of Object.values(record)) {
		const result = findResults<T>(child);
		if (result) return result;
	}
	return null;
}

function findBookmark(value: unknown): string | null {
	if (Array.isArray(value)) {
		for (const item of value) {
			const bookmark = findBookmark(item);
			if (bookmark) return bookmark;
		}
		return null;
	}
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	for (const key of ["bookmark", "current_bookmark", "restored_bookmark"]) {
		if (typeof record[key] === "string" && record[key]) return record[key];
	}
	for (const child of Object.values(record)) {
		const bookmark = findBookmark(child);
		if (bookmark) return bookmark;
	}
	return null;
}

async function validateBaseline(
	expectedPath: string,
	actualPath: string,
	outputDir: string,
): Promise<BaselineValidation> {
	const expectedSha256 = await sha256(expectedPath);
	const actualSha256 = await sha256(actualPath);
	const validation: BaselineValidation = {
		status:
			expectedSha256 === actualSha256
				? "CURRENT STATE RESTORED"
				: "CURRENT STATE NOT RESTORED",
		expectedSha256,
		actualSha256,
		matches: expectedSha256 === actualSha256,
		baselineExport: expectedPath,
		restoredExport: actualPath,
	};
	await writeJson(join(outputDir, "baseline-validation.json"), validation);
	return validation;
}

async function sha256(path: string): Promise<string> {
	const content = await readFile(path);
	return createHash("sha256").update(content).digest("hex");
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeLog(message: string): void {
	process.stderr.write(`${message}\n`);
}

function writeJsonOutput(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function compareStrings(left: string, right: string): number {
	return left.localeCompare(right);
}

async function readJson<T>(path: string): Promise<T> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch (error) {
		throw new Error(
			`无法读取 JSON 文件 ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function renderMarkdownReport(
	report: ClaudeDiffReport,
	metadata: RecoveryMetadata,
): string {
	const lines: string[] = [
		"# Claude Code 历史恢复审计报告",
		"",
		`生成时间：${report.generatedAt}`,
		`PRE_RESET：${metadata.preResetTimestamp} / \`${metadata.preResetBookmark}\``,
		"",
		"## A. Historical Claude Dataset",
		...summaryLines(report.historical),
		`- Claude provider/product pairs: ${formatProductPairs(report.historicalProductPairs)}`,
		"",
		"### Historical daily coverage",
		...coverageTable(report.historicalCoverage),
		"",
		"## B. Current Claude Dataset",
		...summaryLines(report.current),
		`- Claude provider/product pairs: ${formatProductPairs(report.currentProductPairs)}`,
		"",
		"### Current daily coverage",
		...coverageTable(report.currentCoverage),
		"",
		"## C. Missing Claude Dataset",
		`- Missing date count: ${report.missingDates.length}`,
		`- Missing rows: ${report.missingRows.length}`,
		`- First missing: ${report.missingDates[0] ?? "none"}`,
		`- Last missing: ${report.missingDates.at(-1) ?? "none"}`,
		`- Missing date ranges: ${report.missingDateRanges.length > 0 ? report.missingDateRanges.join("；") : "none"}`,
		...summaryLines(report.missingSummary, "missing"),
		"",
		"## D. Daily Difference",
		"| Date | Historical Claude Rows | Current Claude Rows | Missing Rows | Conflict Rows | Current-only Rows | Status |",
		"| --- | ---: | ---: | ---: | ---: | ---: | --- |",
		...report.daily.map(
			(day) =>
				`| ${day.date} | ${day.historicalRows} | ${day.currentRows} | ${day.missingRows} | ${day.conflictRows} | ${day.currentOnlyRows} | ${day.status} |`,
		),
		"",
		"## E. Recovery Candidates",
		`- Rows safe to INSERT: ${report.missingRows.length}`,
		`- Rows with conflicts: ${report.conflicts.length}`,
		`- Current-only rows preserved: ${report.currentOnlyRows.length}`,
		`- Affected daily_usage device/date pairs: ${report.affectedDays.length}`,
		`- Affected dates: ${report.affectedDates.join("；") || "none"}`,
		`- Missing daily_usage parents: ${metadata.missingDailyUsageParents.length}`,
		`- Safe to execute INSERT SQL after manual confirmation: ${metadata.safeToExecuteInsertSql ? "YES" : "NO"}`,
		"",
		"### Conflict details",
		...conflictTable(report.conflicts),
		"",
		"### Missing totals by provider",
		...aggregateTable(report.missingByProvider),
		"",
		"### Missing totals by model",
		...aggregateTable(report.missingByModel),
		"",
		"### Missing totals by project",
		...aggregateTable(report.missingByProject),
		"",
		"### Missing totals by date",
		...aggregateTable(report.missingByDate),
		"",
		"## F. Activity Difference",
		`- Missing Claude activity dates: ${report.activity.missingDateRanges.join("；") || "none"}`,
		`- Missing activity rows: ${report.activity.missingRows.length}`,
		`- Missing activity events: ${report.activity.missingEvents}`,
		`- Activity conflicts: ${report.activity.conflicts.length}`,
		"",
		"## G. Generated files",
		"- `historical-claude-all.json`",
		"- `current-claude-all.json`",
		"- `historical-claude-activity-all.json`",
		"- `current-claude-activity-all.json`",
		"- `historical-claude-coverage.json` / `current-claude-coverage.json`",
		"- `claude-diff.json`",
		"- `restore-missing-claude.sql`",
		"- `recalculate-affected-daily-usage.sql`",
		"- `current-provider-product-distribution.json` / `historical-provider-product-distribution.json`",
		"- `current-activity-provider-product-distribution.json` / `historical-activity-provider-product-distribution.json`",
		"- `CURRENT_BOOKMARK` / `UNDO_BOOKMARK`",
		"- `current-full-export.sql` / `restored-current-export.sql`",
		"- `baseline-validation.json`",
		"",
		"## H. STOP",
		"- 本工具未执行 `restore-missing-claude.sql`。",
		"- 本工具未执行 `recalculate-affected-daily-usage.sql`。",
		`- Current baseline：${metadata.baselineValidation.status}。`,
		"- 等待人工确认后再决定是否执行最终补数。",
		"",
	];
	return `${lines.join("\n")}\n`;
}

function summaryLines(
	summary: ClaudeDiffReport["historical"],
	prefix = "",
): string[] {
	const label = prefix ? `${prefix} ` : "";
	return [
		`- First date: ${summary.firstDate ?? "none"}`,
		`- Last date: ${summary.lastDate ?? "none"}`,
		`- Dates: ${summary.dateCount}`,
		`- Rows: ${summary.rows}`,
		`- Events: ${summary.events}`,
		`- Sessions: ${summary.sessions}`,
		`- ${label}Input tokens: ${summary.inputTokens}`,
		`- ${label}Cached input tokens: ${summary.cachedInputTokens}`,
		`- ${label}Cache write tokens: ${summary.cacheWriteTokens}`,
		`- ${label}Output tokens: ${summary.outputTokens}`,
		`- ${label}Reasoning tokens: ${summary.reasoningTokens}`,
		`- ${label}Total tokens: ${summary.totalTokens}`,
		`- ${label}Estimated cost: ${summary.estimatedCostUsd}`,
	];
}

function formatProductPairs(
	pairs: ClaudeDiffReport["historicalProductPairs"],
): string {
	if (pairs.length === 0) return "none";
	return pairs
		.map(
			(pair) =>
				`${pair.provider}/${pair.product} (${pair.rows} rows, ${pair.firstDate ?? "none"} ~ ${pair.lastDate ?? "none"})`,
		)
		.join("；");
}

function coverageTable(rows: ClaudeDiffReport["historicalCoverage"]): string[] {
	if (rows.length === 0) return ["_none_"];
	return [
		"| Date | Rows | Providers | Models | Projects | Events | Input | Cache read | Cache write | Output | Estimated cost |",
		"| --- | ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
		...rows.map(
			(row) =>
				`| ${row.date} | ${row.rows} | ${escapeMarkdown(row.providers.join(", "))} | ${escapeMarkdown(row.models.join(", "))} | ${escapeMarkdown(row.projects.join(", "))} | ${row.events} | ${row.inputTokens} | ${row.cachedInputTokens} | ${row.cacheWriteTokens} | ${row.outputTokens} | ${row.estimatedCostUsd} |`,
		),
	];
}

function conflictTable(rows: ClaudeDiffReport["conflicts"]): string[] {
	if (rows.length === 0) return ["_none_"];
	return [
		"| Key | Changed fields |",
		"| --- | --- |",
		...rows.map(
			(row) =>
				`| ${escapeMarkdown(Object.values(row.key).join(" / "))} | ${escapeMarkdown(row.differences.map((diff) => diff.field).join(", "))} |`,
		),
	];
}

function aggregateTable(rows: ClaudeDiffReport["missingByProvider"]): string[] {
	if (rows.length === 0) return ["_none_"];
	return [
		"| Group | Rows | Sessions | Events | Input | Cache read | Cache write | Output | Reasoning | Cost |",
		"| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
		...rows.map(
			(row) =>
				`| ${escapeMarkdown(row.group)} | ${row.rows} | ${row.sessions} | ${row.events} | ${row.inputTokens} | ${row.cachedInputTokens} | ${row.cacheWriteTokens} | ${row.outputTokens} | ${row.reasoningTokens} | ${row.estimatedCostUsd} |`,
		),
	];
}

function escapeMarkdown(value: string): string {
	return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function printHelp(): void {
	process.stdout.write(`Usage:
  pnpm --filter @aiusage/worker run db:recover-claude -- --remote --uploader-paused --yes [options]

该工具会：
  1. 导出当前完整 D1，保存 CURRENT_BOOKMARK、全部 Claude breakdown/activity；
  2. 临时 restore PRE_RESET，保存历史全量 Claude breakdown/activity；
  3. 立即 restore UNDO_BOOKMARK，并以完整导出 SHA-256 验证 CURRENT STATE RESTORED；
  4. 离线计算 historical MINUS current，生成审计报告和仅 INSERT 的 SQL；
  5. 永远不执行 restore-missing-claude.sql 或 daily_usage 重算 SQL。

Options:
  --remote                         必填，使用远程 aiusage-db
  --uploader-paused                确认 uploader 已暂停
  --yes                            确认允许临时 Time Travel restore
  --output-dir PATH                输出目录（默认 tmp/d1-claude-recovery-<timestamp>）
  --pre-reset-timestamp RFC3339    PRE_RESET 时间（默认 ${PRE_RESET_TIMESTAMP}）
  --pre-reset-bookmark BOOKMARK    PRE_RESET bookmark（默认 ${PRE_RESET_BOOKMARK}）
  --claude-product NAME            追加历史 product 别名，可重复传入
`);
}

await main();
