import assert from "node:assert/strict";
import test from "node:test";
import {
	buildBaselineValidation,
	buildSemanticSnapshot,
	buildWranglerExportArgs,
	extractAuthoritativeUndoBookmark,
	resolveUndoBookmark,
	restoreCurrentStateSafely,
	runWithFailSafeCurrentRestore,
} from "./recover-claude.ts";

test("restore previous_bookmark is the authoritative undo bookmark", () => {
	const response = {
		bookmark: "PRE_RESET",
		previous_bookmark: "CURRENT",
	};

	assert.equal(extractAuthoritativeUndoBookmark(response), "CURRENT");
	assert.deepEqual(resolveUndoBookmark(response, "PRE_OPERATION"), {
		bookmark: "CURRENT",
		source: "restore.previous_bookmark",
		authoritative: true,
		previousBookmark: "CURRENT",
	});
});

test("missing previous_bookmark uses an explicit emergency path and never bookmark", () => {
	const response = { bookmark: "PRE_RESET" };

	assert.equal(extractAuthoritativeUndoBookmark(response), null);
	assert.deepEqual(resolveUndoBookmark(response, "CURRENT"), {
		bookmark: "CURRENT",
		source: "pre-operation-current-bookmark-emergency",
		authoritative: false,
		previousBookmark: null,
	});
});

test("the fail-safe finally callback runs when the historical phase fails", async () => {
	let restoreAttempts = 0;

	await assert.rejects(
		runWithFailSafeCurrentRestore(
			async () => {
				throw new Error("Phase D/E failed");
			},
			async () => {
				restoreAttempts += 1;
			},
		),
		/Phase D\/E failed/,
	);

	assert.equal(restoreAttempts, 1);
});

test("current restore failure is surfaced with a manual recovery command", async () => {
	await assert.rejects(
		restoreCurrentStateSafely("CURRENT", async () => {
			throw new Error("restore unavailable");
		}),
		/手工命令.*CURRENT/,
	);
});

test("Wrangler 4.80 export args do not include skip-confirmation", () => {
	const args = buildWranglerExportArgs("aiusage-db", "current.sql");

	assert.deepEqual(args, [
		"d1",
		"export",
		"aiusage-db",
		"--remote",
		"--output",
		"current.sql",
	]);
	assert.equal(args.includes("--skip-confirmation"), false);
});

function semanticSnapshot(hostname) {
	return buildSemanticSnapshot({
		devices: {
			keyFields: ["device_id"],
			rows: [{ device_id: "device-a", hostname }],
		},
		daily_usage: {
			keyFields: ["device_id", "usage_date"],
			rows: [
				{ device_id: "device-a", usage_date: "2026-08-27", event_count: 1 },
			],
		},
		daily_usage_breakdown: {
			keyFields: [
				"device_id",
				"usage_date",
				"provider",
				"product",
				"channel",
				"model",
				"project",
			],
			rows: [],
		},
		daily_activity_breakdown: {
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
			rows: [],
		},
		schema: {
			keyFields: ["type", "name", "tbl_name"],
			rows: [{ type: "table", name: "devices", tbl_name: "devices" }],
		},
	});
}

test("semantic baseline can pass while raw export SHA differs", () => {
	const validation = buildBaselineValidation({
		expectedSemantic: semanticSnapshot("production"),
		actualSemantic: semanticSnapshot("production"),
		expectedSha256: "expected-sha",
		actualSha256: "different-raw-sha",
		baselineExport: "current.sql",
		restoredExport: "restored.sql",
	});

	assert.equal(validation.semanticMatches, true);
	assert.equal(validation.rawExportShaMatches, false);
	assert.equal(validation.status, "CURRENT STATE RESTORED");
	assert.equal(validation.matches, true);
});

test("semantic baseline mismatch stops validation even when raw SHA matches", () => {
	const validation = buildBaselineValidation({
		expectedSemantic: semanticSnapshot("production"),
		actualSemantic: semanticSnapshot("changed"),
		expectedSha256: "same-sha",
		actualSha256: "same-sha",
		baselineExport: "current.sql",
		restoredExport: "restored.sql",
	});

	assert.equal(validation.semanticMatches, false);
	assert.equal(validation.semanticMismatchCount, 1);
	assert.equal(validation.rawExportShaMatches, true);
	assert.equal(validation.status, "CURRENT STATE NOT RESTORED");
	assert.equal(validation.matches, false);
});
