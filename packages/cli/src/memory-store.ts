import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  emptyMemoryStore,
  mergeMemoryExtraction,
  type MemoryExtractionResult,
  type MemoryIngestPayload,
  type MemoryProject,
  type MemoryProjectView,
  type MemorySourceReference,
  type MemoryStoreSnapshot,
  type MemoryWorkEvent,
  type MemoryDecision,
  type MemoryNextAction,
  type MemoryProjectState,
} from "@aiusage/memory-core";

export type MemoryDatabase = MemoryStoreSnapshot;

export interface MemoryUpsertSummary {
  projects: number;
  workEvents: number;
  decisions: number;
  supersededDecisions: number;
  nextActions: number;
}

export function getMemoryStorePath(): string {
  return join(homedir(), ".aiusage", "memory.json");
}

export async function readMemoryDatabase(path = getMemoryStorePath()): Promise<MemoryDatabase> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as Partial<MemoryDatabase>;
    return normalizeDatabase(parsed);
  } catch {
    return emptyMemoryDatabase();
  }
}

export async function writeMemoryDatabase(
  database: MemoryDatabase,
  path = getMemoryStorePath(),
): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(database, null, 2)}\n`, "utf-8");
}

export function emptyMemoryDatabase(): MemoryDatabase {
  return emptyMemoryStore();
}

export function applyMemoryExtraction(
  database: MemoryDatabase,
  result: MemoryExtractionResult,
): MemoryUpsertSummary {
  const merged = mergeMemoryExtraction(database, result);
  Object.assign(database, merged.snapshot);
  return {
    projects: merged.inserted.projects,
    workEvents: merged.inserted.workEvents,
    decisions: merged.inserted.decisions,
    supersededDecisions: merged.inserted.supersededDecisions,
    nextActions: merged.inserted.nextActions,
  };
}

export function projectViews(
  database: MemoryDatabase,
  query?: string,
  limit = 50,
): MemoryProjectView[] {
  const normalizedQuery = query?.trim().toLocaleLowerCase();
  const projects = database.projects
    .filter((project) => {
      if (!normalizedQuery) return true;
      return [project.projectName, project.projectKey, project.projectId, project.repoUrl]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase().includes(normalizedQuery));
    })
    .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
    .slice(0, limit);

  return projects.map((project) => ({
    project,
    state: database.projectStates.find((state) => state.projectId === project.projectId),
    recentDecisions: database.decisions
      .filter((decision) => decision.projectId === project.projectId)
      .sort((left, right) => right.validFrom.localeCompare(left.validFrom))
      .slice(0, 8),
    recentEvents: database.workEvents
      .filter((event) => event.projectId === project.projectId)
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
      .slice(0, 12),
    nextActions: database.nextActions
      .filter((action) => action.projectId === project.projectId && action.status !== "CANCELLED")
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 8),
  }));
}

export function findProject(database: MemoryDatabase, query: string): MemoryProject | undefined {
  const normalized = query.trim().toLocaleLowerCase();
  return database.projects.find((project) =>
    [project.projectId, project.projectName, project.projectKey]
      .filter(Boolean)
      .some((value) => value.toLocaleLowerCase() === normalized),
  );
}

/** Remove local paths before a user explicitly opts into cloud Memory sync. */
export function buildCloudMemoryPayload(
  results: MemoryExtractionResult[],
): MemoryIngestPayload {
  const projects = uniqueBy(results.map((result) => sanitizeProject(result.project)), (item) => item.projectId);
  const workEvents = uniqueBy(
    results.flatMap((result) => result.workEvents).map(sanitizeEvent),
    (item) => item.id,
  );
  const decisions = uniqueBy(
    results.flatMap((result) => result.decisions).map(sanitizeDecision),
    (item) => item.id,
  );
  const projectStates = uniqueBy(
    results.flatMap((result) => (result.projectState ? [result.projectState] : [])).map(sanitizeState),
    (item) => item.projectId,
  );
  const nextActions = uniqueBy(
    results.flatMap((result) => result.nextActions).map(sanitizeAction),
    (item) => item.id,
  );
  return {
    schemaVersion: "memory-v1",
    generatedAt: new Date().toISOString(),
    projects,
    workEvents,
    decisions,
    projectStates,
    nextActions,
  };
}

function sanitizeProject(project: MemoryProject): MemoryProject {
  const {
    repoPath: _repoPath,
    repoUrl: _repoUrl,
    worktreePath: _worktreePath,
    ...safeProject
  } = project;
  return {
    ...safeProject,
    projectKey: project.projectId,
    metadata: sanitizeMetadata(project.metadata),
  };
}

function sanitizeEvent(event: MemoryWorkEvent): MemoryWorkEvent {
  return {
    ...event,
    sourceRef: sanitizeSourceRef(event.sourceRef),
    metadata: sanitizeMetadata(event.metadata),
  };
}

function sanitizeDecision(decision: MemoryDecision): MemoryDecision {
  return { ...decision, sourceRef: sanitizeSourceRef(decision.sourceRef) };
}

function sanitizeState(state: MemoryProjectState): MemoryProjectState {
  return {
    ...state,
    sourceRef: state.sourceRef ? sanitizeSourceRef(state.sourceRef) : undefined,
  };
}

function sanitizeAction(action: MemoryNextAction): MemoryNextAction {
  return { ...action, sourceRef: sanitizeSourceRef(action.sourceRef) };
}

function sanitizeSourceRef(sourceRef: MemorySourceReference): MemorySourceReference {
  return {
    source: sourceRef.source,
    sourceSessionId: sourceRef.sourceSessionId,
    occurredAt: sourceRef.occurredAt,
    sourceRecordId: sourceRef.sourceRecordId,
  };
}

function sanitizeMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !/(path|cwd|repo|command|input)/i.test(key)),
  );
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function normalizeDatabase(value: Partial<MemoryDatabase>): MemoryDatabase {
  return {
    schemaVersion: 1,
    projects: Array.isArray(value.projects) ? value.projects : [],
    workEvents: Array.isArray(value.workEvents) ? value.workEvents : [],
    decisions: Array.isArray(value.decisions) ? value.decisions : [],
    projectStates: Array.isArray(value.projectStates) ? value.projectStates : [],
    nextActions: Array.isArray(value.nextActions) ? value.nextActions : [],
  };
}
