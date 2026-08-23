import type { InteractionMetricItem } from "@aiusage/shared";
import type { Env } from "../types.js";

export type ProjectVisibility = "hidden" | "masked" | "plain";

export interface PublicProjectIdentity {
	value: string;
	label: string;
	nodeId: string;
	displayCode: string;
}

export interface PublicProjectFilter {
	databaseValues: string[];
	selection: string[];
}

const NO_PUBLIC_PROJECT_MATCH = "__aiusage_no_public_project_match__";
const PUBLIC_PROJECT_TOKEN_PREFIX = "p_";
const DISPLAY_CODE_LENGTH = 6;

type PublicMetricKind = "tool" | "skill" | "agent";

export function getProjectVisibility(
	env: Pick<Env, "PUBLIC_PROJECT_VISIBILITY">,
): ProjectVisibility {
	const visibility = String(env.PUBLIC_PROJECT_VISIBILITY ?? "masked");
	return visibility === "hidden" || visibility === "plain"
		? visibility
		: "masked";
}

/**
 * PROJECT_NAME_SALT is a stable Worker secret. It must not be generated per
 * request or redeploy, otherwise public project identities would drift.
 */
function getProjectNameSalt(env: Pick<Env, "PROJECT_NAME_SALT">): string {
	const salt = String(env.PROJECT_NAME_SALT ?? "");
	if (!salt)
		throw new Error(
			"PROJECT_NAME_SALT is required for masked project identity",
		);
	return salt;
}

/**
 * Convert the internal project grouping key into the only project identity
 * allowed to cross the public API boundary.
 */
export async function toPublicProjectIdentity(
	project: string,
	env: Pick<Env, "PUBLIC_PROJECT_VISIBILITY" | "PROJECT_NAME_SALT">,
): Promise<PublicProjectIdentity> {
	const raw = String(project ?? "");
	const visibility = getProjectVisibility(env);

	if (visibility === "hidden") {
		return {
			value: "hidden",
			label: "Hidden",
			nodeId: "project-hidden",
			displayCode: "HIDDEN",
		};
	}

	if (visibility === "plain") {
		return {
			value: raw,
			label: raw,
			nodeId: `project-${raw}`,
			displayCode: raw,
		};
	}

	// Public sentinel buckets remain readable without exposing a private name.
	const normalized = raw.trim().toLowerCase();
	if (normalized === "other") {
		return {
			value: "other",
			label: "Other",
			nodeId: "project-other",
			displayCode: "OTHER",
		};
	}
	if (normalized === "unknown") {
		return {
			value: "unknown",
			label: "Unknown",
			nodeId: "project-unknown",
			displayCode: "UNKNOWN",
		};
	}
	if (normalized === "hidden") {
		return {
			value: "hidden",
			label: "Hidden",
			nodeId: "project-hidden",
			displayCode: "HIDDEN",
		};
	}

	const digest = await hmacSha256Hex(raw, getProjectNameSalt(env));
	const displayCode = digest.slice(0, DISPLAY_CODE_LENGTH).toUpperCase();
	const value = `${PUBLIC_PROJECT_TOKEN_PREFIX}${digest}`;
	return {
		value,
		label: `Project ${displayCode}`,
		nodeId: `project-${value}`,
		displayCode,
	};
}

/** Backwards-compatible display-only projection for existing Worker callers. */
export async function toPublicProjectName(
	project: string,
	env: Env,
): Promise<string> {
	return (await toPublicProjectIdentity(project, env)).label;
}

/**
 * Resolve public project filter values back to internal values without ever
 * echoing an untrusted/raw project value in a masked public response.
 */
export async function resolvePublicProjectFilter(
	values: string[],
	env: Env,
): Promise<PublicProjectFilter> {
	const requested = [
		...new Set(values.map((value) => value.trim()).filter(Boolean)),
	];
	if (requested.length === 0) return { databaseValues: [], selection: [] };

	const visibility = getProjectVisibility(env);
	if (visibility === "plain") {
		return { databaseValues: requested, selection: requested };
	}

	if (visibility === "hidden") {
		return requested.includes("hidden")
			? { databaseValues: [], selection: ["hidden"] }
			: { databaseValues: [NO_PUBLIC_PROJECT_MATCH], selection: [] };
	}

	const internalProjects = await loadInternalProjectValues(env);
	const matches = new Map<string, string[]>();
	for (const project of internalProjects) {
		const identity = await toPublicProjectIdentity(project, env);
		const current = matches.get(identity.value) ?? [];
		current.push(project);
		matches.set(identity.value, current);
	}

	const databaseValues = requested.flatMap((value) => matches.get(value) ?? []);
	return {
		databaseValues:
			databaseValues.length > 0
				? [...new Set(databaseValues)]
				: [NO_PUBLIC_PROJECT_MATCH],
		selection: requested.filter((value) => matches.has(value)),
	};
}

/**
 * Keep activity metrics useful while preventing skill/agent/task/tool names
 * from becoming an accidental second project-identification channel.
 */
export async function toPublicInteractionItems(
	items: InteractionMetricItem[],
	kind: PublicMetricKind,
	env: Pick<Env, "PUBLIC_PROJECT_VISIBILITY" | "PROJECT_NAME_SALT">,
): Promise<InteractionMetricItem[]> {
	const visibility = getProjectVisibility(env);
	if (visibility === "plain") return items;
	if (visibility === "hidden") return [];

	const prefix = kind[0].toUpperCase() + kind.slice(1);
	return Promise.all(
		items.map(async (item) => {
			const digest = await hmacSha256Hex(
				`${kind}:${item.value}`,
				getProjectNameSalt(env),
			);
			const code = digest.slice(0, DISPLAY_CODE_LENGTH).toUpperCase();
			return {
				...item,
				value: `${kind}-${code}`,
				label: `${prefix} ${code}`,
			};
		}),
	);
}

async function loadInternalProjectValues(env: Env): Promise<string[]> {
	try {
		const rows = await env.DB.prepare(`
      SELECT DISTINCT project
      FROM (
        SELECT COALESCE(b.project_alias, b.project_display) AS project
        FROM daily_usage_breakdown b
        UNION
        SELECT COALESCE(a.project_alias, a.project_display) AS project
        FROM daily_activity_breakdown a
      )
      WHERE project IS NOT NULL AND project != ''
    `)
			.bind()
			.all<{ project: string | null }>();
		return [
			...new Set(
				(rows.results ?? [])
					.map((row) => String(row.project ?? ""))
					.filter(Boolean),
			),
		];
	} catch {
		// Older local databases may not have the activity migration yet.
		const rows = await env.DB.prepare(`
      SELECT DISTINCT COALESCE(b.project_alias, b.project_display) AS project
      FROM daily_usage_breakdown b
      WHERE project IS NOT NULL AND project != ''
    `)
			.bind()
			.all<{ project: string | null }>();
		return [
			...new Set(
				(rows.results ?? [])
					.map((row) => String(row.project ?? ""))
					.filter(Boolean),
			),
		];
	}
}

async function hmacSha256Hex(value: string, salt: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(salt),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(value),
	);
	return [...new Uint8Array(signature)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}
