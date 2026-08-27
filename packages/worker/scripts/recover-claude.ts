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

const QUERY_PAGE_SIZE = 500;
const SEMANTIC_SCHEMA_NAMES = [
	"devices",
	"daily_usage",
	"daily_usage_breakdown",
	"daily_activity_breakdown",
	"d1_migrations",
] as const;
const SEMANTIC_SCHEMA_NAMES_SQL = SEMANTIC_SCHEMA_NAMES.map(
	(name) => `'${name}'`,
).join(", ");
const SCHEMA_QUERY = `
SELECT type, name, tbl_name, sql
FROM sqlite_master
WHERE type IN ('table', 'index', 'trigger', 'view')
  AND (name IN (${SEMANTIC_SCHEMA_NAMES_SQL}) OR tbl_name IN (${SEMANTIC_SCHEMA_NAMES_SQL}))
ORDER BY type, name, tbl_name`;

const SEMANTIC_TABLE_SPECS = [
	{ name: "devices", keyFields: ["device_id"], orderBy: ["device_id"] },
	{
		name: "daily_usage",
		keyFields: ["device_id", "usage_date"],
		orderBy: ["device_id", "usage_date"],
	},
	{
		name: "daily_usage_breakdown",
		keyFields: [
			"device_id",
			"usage_date",
			"provider",
			"product",
			"channel",
			"model",
			"project",
		],
		orderBy: [
			"device_id",
			"usage_date",
			"provider",
			"product",
			"channel",
			"model",
			"project",
		],
	},
	{
		name: "daily_activity_breakdown",
		keyFields: [
			"device_id",
			"usage_date",
			"provider",
			"product",
			"source",
			"project",
			"kind",
			"name",
			"confidence",
		],
		orderBy: [
			"device_id",
			"usage_date",
			"provider",
			"product",
			"source",
			"project",
			"kind",
			"name",
			"confidence",
		],
	},
	{
		name: "d1_migrations",
		keyFields: ["id"],
		orderBy: ["id"],
	},
] as const;

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

export interface UndoBookmarkResolution {
	bookmark: string;
	source:
		| "restore.previous_bookmark"
		| "pre-operation-current-bookmark-emergency";
	authoritative: boolean;
	previousBookmark: string | null;
}

export interface SemanticTableSnapshot {
	present: boolean;
	rowCount: number;
	semanticHash: string;
	rows: RawDatabaseRow[];
	keyFields: readonly string[];
}

export interface SemanticSnapshot {
	tables: Record<string, SemanticTableSnapshot>;
}

export interface SemanticTableSummary {
	present: boolean;
	rowCount: number;
	semanticHash: string;
}

export interface SemanticTableComparison {
	expected: SemanticTableSummary;
	actual: SemanticTableSummary;
	mismatchCount: number;
	matches: boolean;
}

export interface SemanticComparison {
	semanticMatches: boolean;
	semanticMismatchCount: number;
	tables: Record<string, SemanticTableComparison>;
}

export interface BaselineValidation {
	status: "CURRENT STATE RESTORED" | "CURRENT STATE NOT RESTORED";
	semanticMatches: boolean;
	semanticMismatchCount: number;
	semanticTables: Record<string, SemanticTableComparison>;
	rawExportShaMatches: boolean;
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
	undoBookmarkSource: UndoBookmarkResolution["source"] | null;
	outputDir: string;
	baselineValidation: BaselineValidation;
	restoreCurrentAttempted: boolean;
	restoreCurrentSucceeded: boolean;
	affectedDeviceDateCount: number;
	affectedDates: string[];
	missingDailyUsageParents: AffectedDay[];
	safeToExecuteInsertSql: boolean;
	sqlExecuted: false;
}

export interface SemanticTableInput {
	present?: boolean;
	rows?: readonly RawDatabaseRow[];
	keyFields?: readonly string[];
}

export function extractAuthoritativeUndoBookmark(
	value: unknown,
): string | null {
	if (Array.isArray(value)) {
		for (const item of value) {
			const bookmark = extractAuthoritativeUndoBookmark(item);
			if (bookmark) return bookmark;
		}
		return null;
	}
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const previousBookmark = record.previous_bookmark;
	if (
		typeof previousBookmark === "string" &&
		previousBookmark.trim().length > 0
	) {
		return previousBookmark;
	}
	for (const child of Object.values(record)) {
		const bookmark = extractAuthoritativeUndoBookmark(child);
		if (bookmark) return bookmark;
	}
	return null;
}

export function resolveUndoBookmark(
	response: unknown,
	preOperationCurrentBookmark: string,
): UndoBookmarkResolution {
	if (!preOperationCurrentBookmark.trim()) {
		throw new Error("缺少 pre-operation CURRENT_BOOKMARK，无法进入 fail-safe 恢复。");
	}
	const previousBookmark = extractAuthoritativeUndoBookmark(response);
	if (previousBookmark) {
		return {
			bookmark: previousBookmark,
			source: "restore.previous_bookmark",
			authoritative: true,
			previousBookmark,
		};
	}
	return {
		bookmark: preOperationCurrentBookmark,
		source: "pre-operation-current-bookmark-emergency",
		authoritative: false,
		previousBookmark: null,
	};
}

export function buildWranglerExportArgs(
	database: string,
	output: string,
): string[] {
	return ["d1", "export", database, "--remote", "--output", output];
}

export function buildWranglerRestoreArgs(
	database: string,
	bookmark: string,
): string[] {
	return ["d1", "time-travel", "restore", database, "--bookmark", bookmark, "--json"];
}

export async function runWithFailSafeCurrentRestore<T>(
	operation: () => Promise<T>,
	restoreCurrent: () => Promise<void>,
): Promise<T> {
	try {
		return await operation();
	} finally {
		await restoreCurrent();
	}
}

export async function restoreCurrentStateSafely(
	bookmark: string,
	restore: (bookmark: string) => Promise<unknown> = restoreToBookmark,
	authoritativeBookmark: string | null = null,
): Promise<void> {
	writeLog(`RESTORE_CURRENT_ATTEMPTED=true`);
	writeLog(`RESTORE_CURRENT_TARGET_BOOKMARK=${bookmark}`);
	try {
		await restore(bookmark);
		writeLog("RESTORE_CURRENT_SUCCEEDED=true");
	} catch (error) {
		writeLog("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
		writeLog("CRITICAL: RESTORE_CURRENT_SUCCEEDED=false");
		writeLog(
			`AUTHORITATIVE_UNDO_BOOKMARK=${authoritativeBookmark ?? "UNAVAILABLE"}`,
		);
		writeLog(
			`MANUAL_RECOVERY_COMMAND=wrangler d1 time-travel restore ${DATABASE} --bookmark=${bookmark}`,
		);
		writeLog("人工恢复 current state 后才能继续任何分析或 SQL 操作。");
		throw new Error(
			`恢复 current state 失败；请执行手工命令恢复 bookmark ${bookmark}：${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export function buildSemanticSnapshot(
	inputs: Record<string, SemanticTableInput>,
): SemanticSnapshot {
	const tables: Record<string, SemanticTableSnapshot> = {};
	for (const [name, input] of Object.entries(inputs)) {
		const present = input.present ?? true;
		const keyFields = [...(input.keyFields ?? [])];
		const rows = present ? sortSemanticRows(input.rows ?? [], keyFields) : [];
		const canonicalRows = rows.map((row) => canonicalizeSemanticValue(row));
		tables[name] = {
			present,
			rowCount: rows.length,
			semanticHash: hashUtf8(
				canonicalJson({ present, rows: canonicalRows }),
			),
			rows,
			keyFields,
		};
	}
	return { tables };
}

export function compareSemanticSnapshots(
	expected: SemanticSnapshot,
	actual: SemanticSnapshot,
): SemanticComparison {
	const tableNames = [
		...new Set([
			...Object.keys(expected.tables),
			...Object.keys(actual.tables),
		]),
	].sort(compareStrings);
	const tables: Record<string, SemanticTableComparison> = {};
	let semanticMismatchCount = 0;
	for (const name of tableNames) {
		const expectedTable = expected.tables[name] ?? emptySemanticTable();
		const actualTable = actual.tables[name] ?? emptySemanticTable();
		const mismatchCount = semanticTableMismatchCount(expectedTable, actualTable);
		const comparison = {
			expected: semanticTableSummary(expectedTable),
			actual: semanticTableSummary(actualTable),
			mismatchCount,
			matches: mismatchCount === 0,
		};
		tables[name] = comparison;
		semanticMismatchCount += mismatchCount;
	}
	return {
		semanticMatches: semanticMismatchCount === 0,
		semanticMismatchCount,
		tables,
	};
}

export function buildBaselineValidation(options: {
	expectedSemantic: SemanticSnapshot;
	actualSemantic: SemanticSnapshot;
	expectedSha256: string;
	actualSha256: string | null;
	baselineExport: string;
	restoredExport: string | null;
}): BaselineValidation {
	const semantic = compareSemanticSnapshots(
		options.expectedSemantic,
		options.actualSemantic,
	);
	const rawExportShaMatches =
		options.actualSha256 !== null &&
		options.expectedSha256 === options.actualSha256;
	return {
		status: semantic.semanticMatches
			? "CURRENT STATE RESTORED"
			: "CURRENT STATE NOT RESTORED",
		semanticMatches: semantic.semanticMatches,
		semanticMismatchCount: semantic.semanticMismatchCount,
		semanticTables: semantic.tables,
		rawExportShaMatches,
		expectedSha256: options.expectedSha256,
		actualSha256: options.actualSha256,
		matches: semantic.semanticMatches,
		baselineExport: options.baselineExport,
		restoredExport: options.restoredExport,
	};
}

function sortSemanticRows(
	rows: readonly RawDatabaseRow[],
	keyFields: readonly string[],
): RawDatabaseRow[] {
	return [...rows].sort((left, right) => {
		for (const field of keyFields) {
			const comparison = compareSemanticValues(left[field], right[field]);
			if (comparison !== 0) return comparison;
		}
		return compareStrings(canonicalJson(left), canonicalJson(right));
	});
}

function compareSemanticValues(left: unknown, right: unknown): number {
	return compareStrings(canonicalJson(left ?? null), canonicalJson(right ?? null));
}

function semanticTableMismatchCount(
	expected: SemanticTableSnapshot,
	actual: SemanticTableSnapshot,
): number {
	if (expected.present !== actual.present) return 1;
	if (!expected.present) return 0;
	if (
		expected.rowCount === actual.rowCount &&
		expected.semanticHash === actual.semanticHash
	) {
		return 0;
	}
	const keyFields =
		expected.keyFields.length > 0 ? expected.keyFields : actual.keyFields;
	const expectedRows = new Map(
		expected.rows.map((row) => [semanticRowKey(row, keyFields), row]),
	);
	const actualRows = new Map(
		actual.rows.map((row) => [semanticRowKey(row, keyFields), row]),
	);
	let mismatchCount = 0;
	for (const [key, expectedRow] of expectedRows) {
		const actualRow = actualRows.get(key);
		if (!actualRow || canonicalJson(expectedRow) !== canonicalJson(actualRow)) {
			mismatchCount += 1;
		}
	}
	for (const key of actualRows.keys()) {
		if (!expectedRows.has(key)) mismatchCount += 1;
	}
	return mismatchCount || 1;
}

function semanticRowKey(
	row: RawDatabaseRow,
	keyFields: readonly string[],
): string {
	return canonicalJson(
		keyFields.length > 0
			? keyFields.map((field) => row[field] ?? null)
			: row,
	);
}

function semanticTableSummary(
	table: SemanticTableSnapshot,
): SemanticTableSummary {
	return {
		present: table.present,
		rowCount: table.rowCount,
		semanticHash: table.semanticHash,
	};
}

function emptySemanticTable(): SemanticTableSnapshot {
	return {
		present: false,
		rowCount: 0,
		semanticHash: hashUtf8(canonicalJson({ present: false, rows: [] })),
		rows: [],
		keyFields: [],
	};
}

function canonicalizeSemanticValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalizeSemanticValue);
	if (value && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort(
			compareStrings,
		)) {
			result[key] = canonicalizeSemanticValue(
				(value as Record<string, unknown>)[key],
			);
		}
		return result;
	}
	return value;
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalizeSemanticValue(value));
}

function hashUtf8(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

async function querySemanticSnapshot(): Promise<SemanticSnapshot> {
	const schemaRows = await queryRows<RawDatabaseRow>(SCHEMA_QUERY);
	const existingTables = new Set(
		schemaRows.flatMap((row) =>
			row.type === "table" ? [String(row.name ?? "")] : [],
		),
	);
	const inputs: Record<string, SemanticTableInput> = {
		schema: {
			rows: schemaRows,
			keyFields: ["type", "name", "tbl_name"],
		},
	};
	for (const spec of SEMANTIC_TABLE_SPECS) {
		inputs[spec.name] = existingTables.has(spec.name)
			? {
					rows: await queryRows<RawDatabaseRow>(
						`SELECT * FROM ${spec.name} ORDER BY ${spec.orderBy.join(", ")}`,
					),
					keyFields: spec.keyFields,
				}
			: { present: false, keyFields: spec.keyFields };
	}
	return buildSemanticSnapshot(inputs);
}

async function writeUndoBookmarkArtifacts(
	outputDir: string,
	resolution: UndoBookmarkResolution,
	response: unknown,
): Promise<void> {
	await writeFile(
		join(outputDir, "UNDO_BOOKMARK"),
		`${resolution.bookmark}\n`,
		"utf8",
	);
	await writeJson(join(outputDir, "undo-bookmark.json"), {
		bookmark: resolution.bookmark,
		previousBookmark: resolution.previousBookmark,
		source: resolution.source,
		authoritative: resolution.authoritative,
		usedForCurrentRestore: true,
		response,
	});
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
	writeLog("Phase A: 获取并保存操作前 CURRENT_BOOKMARK...");
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

	writeLog("Phase B: 导出当前完整数据库并读取全部 breakdown/activity...");
	await exportDatabase(currentExport);
	const [
		currentAllBreakdowns,
		currentAllActivity,
		currentDistribution,
		currentActivityDistribution,
		currentSemanticSnapshot,
	] = await Promise.all([
		queryRows<BreakdownRow>(BREAKDOWN_QUERY),
		queryOptionalRows<ActivityRow>("daily_activity_breakdown", ACTIVITY_QUERY),
		queryRows(PRODUCT_DISTRIBUTION_QUERY),
		queryOptionalRows(
			"daily_activity_breakdown",
			ACTIVITY_DISTRIBUTION_QUERY,
		),
		querySemanticSnapshot(),
	]);
	const currentDailyKeys = currentSemanticSnapshot.tables.daily_usage.rows;
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
	let temporaryRestoreAttempted = false;
	let restoreCurrentAttempted = false;
	let restoreCurrentSucceeded = false;
	let undoBookmark: string | null = null;
	let undoBookmarkSource: UndoBookmarkResolution["source"] | null = null;
	let undoBookmarkArtifactWritten = false;
	let baselineValidation: BaselineValidation | undefined;

	await runWithFailSafeCurrentRestore(
		async () => {
			writeLog(`Phase C: restore PRE_RESET ${options.preResetBookmark}...`);
			temporaryRestoreAttempted = true;
			const restoreResponse = await restoreToBookmark(options.preResetBookmark);
			temporaryRestoreStarted = true;
			writeLog(`temporaryRestoreStarted=${temporaryRestoreStarted}`);
			const undoResolution = resolveUndoBookmark(
				restoreResponse,
				currentBookmarkArtifact.bookmark,
			);
			undoBookmark = undoResolution.bookmark;
			undoBookmarkSource = undoResolution.source;
			if (!undoResolution.authoritative) {
				writeLog(
					"FAIL-SAFE: restore response 缺少 previous_bookmark；禁止使用 response.bookmark 作为 undo。",
				);
				writeLog("AUTHORITATIVE_UNDO_BOOKMARK=UNAVAILABLE");
				writeLog(
					`EMERGENCY_CURRENT_BOOKMARK=${currentBookmarkArtifact.bookmark}`,
				);
			}
			try {
				await writeUndoBookmarkArtifacts(
					outputDir,
					undoResolution,
					restoreResponse,
				);
				undoBookmarkArtifactWritten = true;
			} catch (error) {
				writeLog(
					`UNDO_BOOKMARK artifact 写入失败；仍将执行 fail-safe current restore：${error instanceof Error ? error.message : String(error)}`,
				);
				throw error;
			}
			if (!undoResolution.authoritative) {
				throw new Error(
					"Time Travel restore 未返回 authoritative previous_bookmark；已停止历史分析，仅允许 finally 尝试恢复 pre-operation CURRENT_BOOKMARK。",
				);
			}
			writeLog(`AUTHORITATIVE_UNDO_BOOKMARK=${undoBookmark}`);

			writeLog("Phase D/E: 在历史状态读取全部 Claude breakdown/activity...");
			const [
				historicalAllBreakdowns,
				historicalAllActivity,
				historicalDistribution,
				historicalActivityDistribution,
			] = await Promise.all([
				queryRows<BreakdownRow>(BREAKDOWN_QUERY),
				queryOptionalRows<ActivityRow>(
					"daily_activity_breakdown",
					ACTIVITY_QUERY,
				),
				queryRows(PRODUCT_DISTRIBUTION_QUERY),
				queryOptionalRows(
					"daily_activity_breakdown",
					ACTIVITY_DISTRIBUTION_QUERY,
				),
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
		},
		async () => {
			if (!temporaryRestoreAttempted) return;
			writeLog("Phase F: restore current state immediately...");
			if (!undoBookmark) {
				undoBookmark = currentBookmarkArtifact.bookmark;
				undoBookmarkSource = "pre-operation-current-bookmark-emergency";
			}
			const authoritativeUndoBookmark =
				undoBookmarkSource === "restore.previous_bookmark" ? undoBookmark : null;
			writeLog(
				`AUTHORITATIVE_UNDO_BOOKMARK=${authoritativeUndoBookmark ?? "UNAVAILABLE"}`,
			);
			if (!authoritativeUndoBookmark) {
				writeLog(`EMERGENCY_CURRENT_BOOKMARK=${undoBookmark}`);
			}
			if (!undoBookmarkArtifactWritten) {
				try {
					const artifactResolution: UndoBookmarkResolution =
						undoBookmarkSource === "restore.previous_bookmark"
							? {
									bookmark: undoBookmark,
									source: "restore.previous_bookmark",
									authoritative: true,
									previousBookmark: undoBookmark,
								}
							: {
									bookmark: undoBookmark,
									source: "pre-operation-current-bookmark-emergency",
									authoritative: false,
									previousBookmark: null,
								};
					await writeUndoBookmarkArtifacts(
						outputDir,
						artifactResolution,
						null,
					);
					undoBookmarkArtifactWritten = true;
				} catch (error) {
					writeLog(
						`无法写入 UNDO_BOOKMARK artifact，但仍继续尝试恢复 current：${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
			restoreCurrentAttempted = true;
			await restoreCurrentStateSafely(
				undoBookmark,
				restoreToBookmark,
				authoritativeUndoBookmark,
			);
			restoreCurrentSucceeded = true;
			await exportDatabase(restoredCurrentExport);
			const restoredSemanticSnapshot = await querySemanticSnapshot();
			const validation = await validateBaseline(
				currentExport,
				restoredCurrentExport,
				outputDir,
				currentSemanticSnapshot,
				restoredSemanticSnapshot,
			);
			baselineValidation = validation;
			for (const [table, comparison] of Object.entries(
				validation.semanticTables,
			)) {
				writeLog(
					`BASELINE_SEMANTIC table=${table} expectedRows=${comparison.expected.rowCount} actualRows=${comparison.actual.rowCount} expectedHash=${comparison.expected.semanticHash} actualHash=${comparison.actual.semanticHash} mismatchCount=${comparison.mismatchCount}`,
				);
			}
			if (!validation.semanticMatches) {
				writeLog(
					`CURRENT STATE NOT RESTORED: semantic mismatch count=${validation.semanticMismatchCount}`,
				);
			} else if (!validation.rawExportShaMatches) {
				writeLog(
					"CURRENT STATE semantic validation passed; raw export SHA-256 differs and is diagnostic only.",
				);
			}
		},
	);

	const validatedBaseline = baselineValidation;
	if (!validatedBaseline || !validatedBaseline.semanticMatches) {
		throw new Error(
			"CURRENT STATE RESTORED 语义校验失败；已停止离线分析和 SQL 生成。",
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
		undoBookmarkSource,
		outputDir,
		baselineValidation: validatedBaseline,
		restoreCurrentAttempted,
		restoreCurrentSucceeded,
		affectedDeviceDateCount: report.affectedDays.length,
		affectedDates: report.affectedDates,
		missingDailyUsageParents,
		safeToExecuteInsertSql:
			validatedBaseline.semanticMatches && missingDailyUsageParents.length === 0,
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

async function queryOptionalRows<T>(
	tableName: string,
	sql: string,
): Promise<T[]> {
	const tableRows = await queryRows<{ name: string }>(
		`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${tableName.replaceAll("'", "''")}'`,
	);
	return tableRows.length > 0 ? queryRows<T>(sql) : [];
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
	const bookmark = findInfoBookmark(response);
	if (!bookmark)
		throw new Error(
			`无法从 Time Travel info 响应提取 bookmark: ${JSON.stringify(response)}`,
		);
	return { timestamp, bookmark, response };
}

async function restoreToBookmark(bookmark: string): Promise<unknown> {
	return runWranglerJson(buildWranglerRestoreArgs(DATABASE, bookmark));
}

async function exportDatabase(output: string): Promise<void> {
	await runWrangler(buildWranglerExportArgs(DATABASE, output));
	await assertUtf8File(output);
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

function findInfoBookmark(value: unknown): string | null {
	if (Array.isArray(value)) {
		for (const item of value) {
			const bookmark = findInfoBookmark(item);
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
		const bookmark = findInfoBookmark(child);
		if (bookmark) return bookmark;
	}
	return null;
}

async function validateBaseline(
	expectedPath: string,
	actualPath: string,
	outputDir: string,
	expectedSemantic: SemanticSnapshot,
	actualSemantic: SemanticSnapshot,
): Promise<BaselineValidation> {
	const expectedSha256 = await sha256(expectedPath);
	const actualSha256 = await sha256(actualPath);
	const validation = buildBaselineValidation({
		expectedSemantic,
		actualSemantic,
		expectedSha256,
		actualSha256,
		baselineExport: expectedPath,
		restoredExport: actualPath,
	});
	await writeJson(join(outputDir, "baseline-validation.json"), validation);
	return validation;
}

async function assertUtf8File(path: string): Promise<void> {
	const content = await readFile(path);
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(content);
	} catch (error) {
		throw new Error(
			`文件不是有效 UTF-8：${path}；已停止以避免 Windows code page 污染：${error instanceof Error ? error.message : String(error)}`,
		);
	}
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

/** Use ordinal comparison so recovery ordering matches SQLite case-sensitive TEXT semantics. */
function compareStrings(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
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
		`- UNDO_BOOKMARK source: ${metadata.undoBookmarkSource ?? "none"}`,
		`- RESTORE_CURRENT_ATTEMPTED: ${metadata.restoreCurrentAttempted}`,
		`- RESTORE_CURRENT_SUCCEEDED: ${metadata.restoreCurrentSucceeded}`,
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
		"## H. Baseline validation",
		`- semanticMatches: ${metadata.baselineValidation.semanticMatches}`,
		`- semanticMismatchCount: ${metadata.baselineValidation.semanticMismatchCount}`,
		`- rawExportShaMatches (diagnostic only): ${metadata.baselineValidation.rawExportShaMatches}`,
		...Object.entries(metadata.baselineValidation.semanticTables).map(
			([table, comparison]) =>
				`- ${table}: rows ${comparison.expected.rowCount} -> ${comparison.actual.rowCount}; mismatchCount=${comparison.mismatchCount}; semanticHash ${comparison.expected.semanticHash} -> ${comparison.actual.semanticHash}`,
		),
		"",
		"## I. STOP",
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
  1. 先保存操作前 CURRENT_BOOKMARK，再导出当前完整 D1 和全部 Claude breakdown/activity；
  2. 临时 restore PRE_RESET；仅使用 restore response.previous_bookmark 作为 authoritative UNDO_BOOKMARK；
  3. 无论历史读取是否异常，都立即 restore UNDO_BOOKMARK；
  4. 按 devices/daily_usage/breakdown/activity/schema 语义数据验证 current state；raw export SHA-256 仅作辅助诊断；
  5. 仅在语义验证通过后离线计算 historical MINUS current，永远不执行任何生成 SQL。

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

function isMainModule(): boolean {
	const entrypoint = process.argv[1];
	return Boolean(entrypoint && resolve(entrypoint) === fileURLToPath(import.meta.url));
}

if (isMainModule()) await main();
