import { describe, expect, it } from "vitest";
import { handleBreakdowns } from "./breakdowns.js";
import { buildSankey, handleOverview } from "./overview.js";
import { handleTextTokens } from "./text-metrics.js";
import {
	resolvePublicProjectFilter,
	toPublicInteractionItems,
	toPublicProjectIdentity,
} from "../utils/privacy.js";
import type { Env } from "../types.js";

const SALT = "public-privacy-test-salt";
const PROJECTS = [
	"VERY_PRIVATE_PROJECT_123",
	String.raw`E:\AI生成代码\secret-project`,
	String.raw`C:\Users\xxx\private`,
	"/home/user/private-project",
	"/vol5/1000/ai-workspace/private-project",
	"https-github-com-private-org-private-repo",
	"mysql-192-168-x-x",
];

function makeEnv(
	visibility: "hidden" | "masked" | "plain",
	DB: unknown,
	salt = SALT,
): Env {
	return {
		DB,
		PUBLIC_PROJECT_VISIBILITY: visibility,
		PROJECT_NAME_SALT: salt,
	} as unknown as Env;
}

function makeOverviewDb() {
	const DB = {
		prepare(sql: string) {
			return {
				bind() {
					return {
						async first<T>() {
							if (sql.includes("FROM daily_activity_breakdown")) {
								return {
									exact_count: 1,
									proxy_count: 0,
									user_message_count: 0,
									function_call_count: 1,
									tool_call_count: 1,
									skill_call_count: 1,
									skill_proxy_count: 0,
									subagent_count: 1,
								} as T;
							}
							if (sql.includes("COUNT(DISTINCT b.usage_date)")) {
								return {
									active_days: 1,
									total_events: 5,
									total_sessions: 1,
									cost_bearing_events: 5,
									total_cost_usd: 1,
								} as T;
							}
							return null as T;
						},
						async all<T>() {
							if (sql.includes("SELECT DISTINCT project")) {
								return {
									results: PROJECTS.map((project) => ({ project })),
								} as T;
							}
							if (sql.includes("b.model,") && sql.includes(" AS project")) {
								return {
									results: PROJECTS.map((project, index) => ({
										model: `model-${index}`,
										project,
										total_tokens: 100 + index,
									})),
								} as T;
							}
							if (
								sql.includes(
									"COALESCE(b.project_alias, b.project_display) AS value",
								)
							) {
								return {
									results: PROJECTS.map((value, index) => ({
										value,
										estimated_cost_usd: index + 1,
										event_count: index + 1,
									})),
								} as T;
							}
							if (sql.includes("a.kind IN ('function_call'")) {
								return {
									results: [
										{
											value: `tool-${PROJECTS[0]}`,
											label: `tool-${PROJECTS[0]}`,
											event_count: 1,
											proxy_count: 0,
										},
									],
								} as T;
							}
							if (sql.includes("a.kind IN ('skill_call'")) {
								return {
									results: [
										{
											value: `skill-${PROJECTS[0]}`,
											label: `skill-${PROJECTS[0]}`,
											event_count: 1,
											proxy_count: 0,
										},
									],
								} as T;
							}
							if (sql.includes("a.kind = 'agent_call'")) {
								return {
									results: [
										{
											value: `agent-${PROJECTS[0]}`,
											label: `agent-${PROJECTS[0]}`,
											event_count: 1,
											proxy_count: 0,
										},
									],
								} as T;
							}
							return { results: [] } as T;
						},
					};
				},
			};
		},
	};
	return DB;
}

function makeBreakdownDb(calls: Array<{ sql: string; params: unknown[] }>) {
	return {
		prepare(sql: string) {
			return {
				bind(...params: unknown[]) {
					calls.push({ sql, params });
					return {
						async first<T>() {
							return { total: 1, total_tokens: 1 } as T;
						},
						async all<T>() {
							if (sql.includes("SELECT DISTINCT project")) {
								return {
									results: PROJECTS.map((project) => ({ project })),
								} as T;
							}
							return {
								results: [
									{
										device_id: "device-1",
										usage_date: "2026-07-20",
										provider: "openai",
										product: "codex",
										channel: "cli",
										model: "gpt-5",
										project: PROJECTS[0],
										event_count: 1,
										input_tokens: 10,
										cached_input_tokens: 0,
										cache_write_tokens: 0,
										output_tokens: 5,
										reasoning_output_tokens: 0,
										total_tokens: 15,
										estimated_cost_usd: 1,
										cost_status: "estimated",
									},
								],
							} as T;
						},
					};
				},
			};
		},
	};
}

function expectNoCanaries(serialized: string): void {
	for (const canary of PROJECTS) {
		expect(serialized).not.toContain(canary);
		expect(serialized).not.toContain(canary.replaceAll("\\", "\\\\"));
	}
}

async function readJson<T>(response: Response): Promise<T> {
	try {
		return (await response.json()) as T;
	} catch (error) {
		throw new Error(`Expected JSON response: ${String(error)}`);
	}
}

describe("public project privacy projection", () => {
	it("uses one stable anonymous identity for masked projects", async () => {
		const env = makeEnv("masked", makeOverviewDb());
		const first = await toPublicProjectIdentity(PROJECTS[0], env);
		const redeployed = await toPublicProjectIdentity(
			PROJECTS[0],
			makeEnv("masked", makeOverviewDb()),
		);

		expect(first).toEqual(redeployed);
		expect(first.value).toMatch(/^p_[0-9a-f]{64}$/);
		expect(first.displayCode).toMatch(/^[0-9A-F]{6}$/);
		expect(first.label).toBe(`Project ${first.displayCode}`);
		expect(first.nodeId).toBe(`project-${first.value}`);
		expect(first.value).not.toContain(first.displayCode);
		expect(first.value).not.toContain(PROJECTS[0]);
	});

	it("fails closed when the masked identity secret is missing", async () => {
		await expect(
			toPublicProjectIdentity(
				PROJECTS[0],
				makeEnv("masked", makeOverviewDb(), ""),
			),
		).rejects.toThrow("PROJECT_NAME_SALT");
	});

	it("keeps plain identity behavior and collapses hidden identity safely", async () => {
		const plain = await toPublicProjectIdentity(
			PROJECTS[0],
			makeEnv("plain", makeOverviewDb()),
		);
		expect(plain.value).toBe(PROJECTS[0]);
		expect(plain.label).toBe(PROJECTS[0]);

		const hidden = await toPublicProjectIdentity(
			PROJECTS[0],
			makeEnv("hidden", makeOverviewDb()),
		);
		expect(hidden).toEqual({
			value: "hidden",
			label: "Hidden",
			nodeId: "project-hidden",
			displayCode: "HIDDEN",
		});
	});

	it("redacts activity names in masked/hidden modes while preserving plain data", async () => {
		const items = [
			{
				value: "private-agent-task",
				label: "private-agent-task (claude-code)",
				eventCount: 2,
			},
		];

		const masked = await toPublicInteractionItems(
			items,
			"agent",
			makeEnv("masked", makeOverviewDb()),
		);
		expect(masked).toHaveLength(1);
		expect(masked[0].label).toMatch(/^Agent [0-9A-F]{6}$/);
		expect(JSON.stringify(masked)).not.toContain("private-agent-task");

		const hidden = await toPublicInteractionItems(
			items,
			"agent",
			makeEnv("hidden", makeOverviewDb()),
		);
		expect(hidden).toEqual([]);

		const plain = await toPublicInteractionItems(
			items,
			"agent",
			makeEnv("plain", makeOverviewDb()),
		);
		expect(plain).toEqual(items);
	});

	it("projects public filter ids back to internal values without exposing them", async () => {
		const env = makeEnv("masked", makeOverviewDb());
		const identity = await toPublicProjectIdentity(PROJECTS[0], env);
		const filter = await resolvePublicProjectFilter([identity.value], env);

		expect(filter.selection).toEqual([identity.value]);
		expect(filter.databaseValues).toEqual([PROJECTS[0]]);
	});

	it("keeps hidden project filtering as an aggregate-only selection", async () => {
		const env = makeEnv("hidden", makeOverviewDb());
		const allProjects = await resolvePublicProjectFilter(["hidden"], env);
		const unknownProject = await resolvePublicProjectFilter([PROJECTS[0]], env);

		expect(allProjects).toEqual({ databaseValues: [], selection: ["hidden"] });
		expect(unknownProject.selection).toEqual([]);
		expect(unknownProject.databaseValues).toHaveLength(1);
		expect(unknownProject.databaseValues[0]).not.toContain(PROJECTS[0]);
	});

	it("uses the canonical projectAlias key consistently across public projections", async () => {
		const env = makeEnv("masked", makeOverviewDb());
		const rawProject = String.raw`/home/user/private/customer-portal`;
		const projectAlias = "customer-portal";
		const optionIdentity = await toPublicProjectIdentity(projectAlias, env);
		const sankey = await buildSankey(
			[{ model: "gpt-5", project: projectAlias, total_tokens: 100 }],
			env,
		);
		const breakdownIdentity = await toPublicProjectIdentity(projectAlias, env);

		expect(breakdownIdentity).toEqual(optionIdentity);
		expect(sankey.nodes).toContainEqual(
			expect.objectContaining({
				id: optionIdentity.nodeId,
				label: optionIdentity.label,
			}),
		);
		expect(optionIdentity.value).not.toContain(rawProject);
	});
});

describe("PUBLIC_RESPONSE_PRIVACY_REGRESSION", () => {
	it.each(["masked", "hidden"] as const)(
		"does not expose project canaries in overview JSON (%s)",
		async (visibility) => {
			const response = await handleOverview(
				new URL("https://example.test/api/v1/public/overview?range=all"),
				makeEnv(visibility, makeOverviewDb()),
			);
			const payload = await readJson<Record<string, unknown>>(response);
			const serialized = JSON.stringify(payload);
			expectNoCanaries(serialized);

			const data = payload as {
				filters: {
					options: { projects: Array<{ value: string; label: string }> };
				};
				sankey: {
					nodes: Array<{ id: string; label: string; layer: number }>;
					links: Array<{ source: string; target: string }>;
				};
				interactionMetrics: {
					topSkills: unknown[];
					topAgents: unknown[];
					topTools: unknown[];
				};
			};
			const projectOptions = data.filters.options.projects;
			const projectNodes = data.sankey.nodes.filter((node) => node.layer === 1);
			const nodeIds = new Set(data.sankey.nodes.map((node) => node.id));

			expect(projectOptions.length).toBe(
				visibility === "hidden" ? 1 : PROJECTS.length,
			);
			expect(projectNodes.length).toBe(
				visibility === "hidden" ? 1 : PROJECTS.length,
			);
			expect(
				data.sankey.links.every(
					(link) => nodeIds.has(link.source) && nodeIds.has(link.target),
				),
			).toBe(true);

			if (visibility === "hidden") {
				expect(projectOptions[0]).toMatchObject({
					value: "hidden",
					label: "Hidden",
				});
				expect(projectNodes[0]).toMatchObject({
					id: "project-hidden",
					label: "Hidden",
				});
				expect(data.interactionMetrics.topSkills).toEqual([]);
				expect(data.interactionMetrics.topAgents).toEqual([]);
				expect(data.interactionMetrics.topTools).toEqual([]);
			} else {
				for (const option of projectOptions) {
					expect(option.value).toMatch(/^p_[0-9a-f]{64}$/);
					expect(option.label).toMatch(/^Project [0-9A-F]{6}$/);
					expect(projectNodes.map((node) => node.id)).toContain(
						`project-${option.value}`,
					);
				}
				expect(data.interactionMetrics.topSkills[0]).toMatchObject({
					label: expect.stringMatching(/^Skill [0-9A-F]{6}$/),
				});
				expect(data.interactionMetrics.topAgents[0]).toMatchObject({
					label: expect.stringMatching(/^Agent [0-9A-F]{6}$/),
				});
			}
		},
	);

	it("keeps plain overview project values and activity names unchanged", async () => {
		const response = await handleOverview(
			new URL("https://example.test/api/v1/public/overview?range=all"),
			makeEnv("plain", makeOverviewDb()),
		);
		const payload = await readJson<{
			filters: { options: { projects: Array<{ value: string }> } };
			sankey: { nodes: Array<{ id: string; label: string }> };
			interactionMetrics: { topSkills: Array<{ label: string }> };
		}>(response);

		expect(
			payload.filters.options.projects.map((option) => option.value),
		).toEqual(expect.arrayContaining(PROJECTS));
		expect(payload.filters.options.projects).toHaveLength(PROJECTS.length);
		expect(payload.sankey.nodes).toEqual(
			expect.arrayContaining(
				PROJECTS.map((project) =>
					expect.objectContaining({ id: `project-${project}`, label: project }),
				),
			),
		);
		expect(payload.interactionMetrics.topSkills[0].label).toContain(
			PROJECTS[0],
		);
	});

	it("projects and filters masked breakdowns without leaking the raw project", async () => {
		const calls: Array<{ sql: string; params: unknown[] }> = [];
		const env = makeEnv("masked", makeBreakdownDb(calls));
		const identity = await toPublicProjectIdentity(PROJECTS[0], env);
		const response = await handleBreakdowns(
			new URL(
				`https://example.test/api/v1/public/breakdowns?range=all&project=${identity.value}`,
			),
			env,
		);
		const payload = await readJson<{ data: Array<{ project: string }> }>(
			response,
		);
		const serialized = JSON.stringify(payload);

		expectNoCanaries(serialized);
		expect(payload.data[0].project).toBe(identity.label);
		expect(calls.some((call) => call.params.includes(PROJECTS[0]))).toBe(true);
	});

	it("keeps plain breakdown project names unchanged", async () => {
		const response = await handleBreakdowns(
			new URL("https://example.test/api/v1/public/breakdowns?range=all"),
			makeEnv("plain", makeBreakdownDb([])),
		);
		const payload = await readJson<{ data: Array<{ project: string }> }>(
			response,
		);
		expect(payload.data[0].project).toBe(PROJECTS[0]);
	});

	it("accepts the same anonymous project id in text token metrics", async () => {
		const calls: Array<{ sql: string; params: unknown[] }> = [];
		const env = makeEnv("masked", makeBreakdownDb(calls));
		const identity = await toPublicProjectIdentity(PROJECTS[0], env);
		const response = await handleTextTokens(
			new URL(
				`https://example.test/api/v1/public/text/tokens?range=all&unit=raw&project=${identity.value}`,
			),
			env,
		);

		expect(await response.text()).toBe("1");
		expect(calls.some((call) => call.params.includes(PROJECTS[0]))).toBe(true);
	});

	it("uses anonymous Sankey ids and keeps links joinable", async () => {
		const env = makeEnv("masked", makeOverviewDb());
		const sankey = await buildSankey(
			PROJECTS.slice(0, 2).map((project, index) => ({
				model: "gpt-5",
				project,
				total_tokens: index + 1,
			})),
			env,
		);
		const ids = new Set(sankey.nodes.map((node) => node.id));

		expect(
			sankey.nodes
				.filter((node) => node.layer === 1)
				.every((node) => !node.id.includes(PROJECTS[0])),
		).toBe(true);
		expect(
			sankey.links.every(
				(link) => ids.has(link.source) && ids.has(link.target),
			),
		).toBe(true);
	});
});
