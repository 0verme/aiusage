import type { AIUsageConfig } from "./config.js";
import { RuleBasedMemoryExtractor } from "@aiusage/memory-core";
import {
  applyMemoryExtraction,
  buildCloudMemoryPayload,
  findProject,
  getMemoryStorePath,
  projectViews,
  readMemoryDatabase,
  writeMemoryDatabase,
  type MemoryDatabase,
  type MemoryUpsertSummary,
} from "./memory-store.js";
import { scanMemorySessions } from "./memory-sessions.js";

export interface MemoryProcessResult {
  results: Awaited<ReturnType<typeof scanMemorySessions>>;
  summary: MemoryUpsertSummary;
  cloudPayload?: ReturnType<typeof buildCloudMemoryPayload>;
}

export async function runMemoryCommand(
  flags: Record<string, string | boolean>,
  positionals: string[],
  config: AIUsageConfig,
): Promise<void> {
  const subcommand = positionals[0] || "list";
  const rest = positionals.slice(1);
  if (subcommand === "scan") {
    const dates = resolveMemoryDates(flags);
    const processed = await processMemoryDates(dates, config);
    if (flags.json) {
      console.log(JSON.stringify({ dates, ...processed.summary, storePath: getMemoryStorePath() }, null, 2));
      return;
    }
    console.log(`Memory 扫描 ${dates[0]} ~ ${dates[dates.length - 1]}`);
    console.log(
      `项目 ${processed.summary.projects} · 事件 ${processed.summary.workEvents} · 决策 ${processed.summary.decisions} · Next Action ${processed.summary.nextActions}`,
    );
    if (processed.summary.supersededDecisions > 0) {
      console.log(`已演进决策 ${processed.summary.supersededDecisions} 条`);
    }
    console.log(`本地存储: ${getMemoryStorePath()}`);
    return;
  }

  const database = await readMemoryDatabase();
  if (subcommand === "projects") {
    printProjects(database, flags);
    return;
  }
  if (subcommand === "show") {
    const query = rest.join(" ").trim();
    if (!query) throw new Error("用法: aiusage memory show <project>");
    const project = findProject(database, query);
    if (!project) throw new Error(`未找到项目: ${query}`);
    const view = projectViews(database).find((item) => item.project.projectId === project.projectId);
    if (!view) throw new Error(`项目没有 Memory: ${query}`);
    if (flags.json) {
      console.log(JSON.stringify(view, null, 2));
      return;
    }
    printProjectView(view);
    return;
  }
  if (subcommand === "list") {
    printProjects(database, flags);
    return;
  }
  throw new Error("用法: aiusage memory scan|list|projects|show <project>");
}

export async function processMemoryDates(
  dates: readonly string[],
  config: AIUsageConfig,
): Promise<MemoryProcessResult> {
  const results = await scanMemorySessions({
    dates,
    projectAliases: config.projectAliases,
  });
  const extractor = new RuleBasedMemoryExtractor();
  const extractions = results.map((session) => extractor.extract(session));
  const database = await readMemoryDatabase();
  const summary = emptySummary();
  for (const extraction of extractions) mergeSummary(summary, applyMemoryExtraction(database, extraction));
  if (extractions.length > 0) await writeMemoryDatabase(database);
  return {
    results,
    summary,
    ...(config.memory?.mode === "cloud" && extractions.length > 0
      ? { cloudPayload: buildCloudMemoryPayload(extractions) }
      : {}),
  };
}

export function resolveMemoryDates(flags: Record<string, string | boolean>, now = new Date()): string[] {
  const date = typeof flags.date === "string" ? flags.date : undefined;
  if (date) return [validateDate(date)];
  if (flags.yesterday === true) return [formatDate(addDays(now, -1))];
  if (flags.today === true) return [formatDate(now)];

  const from = typeof flags.from === "string" ? flags.from : undefined;
  const to = typeof flags.to === "string" ? flags.to : undefined;
  if (to && !from) throw new Error("--to 需要搭配 --from 使用");
  if (from) {
    const start = validateDate(from);
    const end = validateDate(to ?? formatDate(now));
    if (start > end) throw new Error("--from 不能晚于 --to");
    return dateRange(start, end);
  }

  const range = typeof flags.range === "string" ? flags.range : "1d";
  const days = parseDays(range);
  if (days === undefined) {
    throw new Error("memory scan 暂不支持 --range all，请使用 --from/--to 指定范围");
  }
  const result: string[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) result.push(formatDate(addDays(now, -offset)));
  return result;
}

function printProjects(database: MemoryDatabase, flags: Record<string, string | boolean>): void {
  const query = typeof flags.query === "string" ? flags.query : undefined;
  const limit = typeof flags.limit === "string" ? Math.max(1, Number(flags.limit) || 20) : 20;
  const views = projectViews(database, query, limit);
  if (flags.json) {
    console.log(JSON.stringify(views, null, 2));
    return;
  }
  if (views.length === 0) {
    console.log("暂无本地 Memory。先运行: aiusage memory scan --yesterday");
    return;
  }
  for (const view of views) {
    console.log(`\n## ${view.project.projectName}`);
    console.log(`  projectId: ${view.project.projectId}`);
    console.log(`  updated: ${view.project.lastSeenAt}`);
    if (view.state) console.log(`  state: ${view.state.summary}`);
    for (const event of view.recentEvents.slice(0, 5)) {
      console.log(`  - [${event.eventType}] ${event.title}`);
    }
  }
}

function printProjectView(view: ReturnType<typeof projectViews>[number]): void {
  console.log(`## ${view.project.projectName}`);
  console.log(`projectId: ${view.project.projectId}`);
  console.log(`updated: ${view.project.lastSeenAt}`);
  if (view.project.repoUrl) console.log(`repo: ${view.project.repoUrl}`);
  console.log("\nCurrent State");
  if (view.state) {
    console.log(`  ${view.state.summary}`);
    console.log(`  phase: ${view.state.currentPhase}`);
    for (const blocker of view.state.blockers) console.log(`  blocker: ${blocker}`);
  } else {
    console.log("  -");
  }
  console.log("\nRecent Decisions");
  for (const decision of view.recentDecisions) {
    console.log(`  - [${decision.status}] ${decision.topic}: ${decision.decision}`);
  }
  console.log("\nRecent Activity");
  for (const event of view.recentEvents) console.log(`  - ${event.occurredAt} [${event.eventType}] ${event.title}`);
  console.log("\nNext");
  for (const action of view.nextActions) console.log(`  - [${action.status}] ${action.content}`);
}

function emptySummary(): MemoryUpsertSummary {
  return { projects: 0, workEvents: 0, decisions: 0, supersededDecisions: 0, nextActions: 0 };
}

function mergeSummary(target: MemoryUpsertSummary, value: MemoryUpsertSummary): void {
  target.projects += value.projects;
  target.workEvents += value.workEvents;
  target.decisions += value.decisions;
  target.supersededDecisions += value.supersededDecisions;
  target.nextActions += value.nextActions;
}

function parseDays(value: string): number | undefined {
  const match = value.match(/^(\d+)([dwm])$/i);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isInteger(amount) || amount < 1) return undefined;
  const unit = match[2].toLowerCase();
  return unit === "w" ? amount * 7 : unit === "m" ? amount * 30 : amount;
}

function dateRange(start: string, end: string): string[] {
  const result: string[] = [];
  for (let date = new Date(`${start}T12:00:00`); date <= new Date(`${end}T12:00:00`); date = addDays(date, 1)) {
    result.push(formatDate(date));
  }
  return result;
}

function validateDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`日期格式无效: ${value}`);
  return value;
}

function addDays(value: Date, amount: number): Date {
  const result = new Date(value);
  result.setDate(result.getDate() + amount);
  return result;
}

function formatDate(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}
