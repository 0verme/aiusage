import { normalizeMemoryText } from './fingerprint.js';
import type {
  MemoryDecision,
  MemoryExtractionResult,
  MemoryNextAction,
  MemoryStoreSnapshot,
  MemoryWorkEvent,
} from './types.js';

export function emptyMemoryStore(): MemoryStoreSnapshot {
  return {
    schemaVersion: 1,
    projects: [],
    workEvents: [],
    decisions: [],
    projectStates: [],
    nextActions: [],
  };
}

export interface MemoryMergeCounts {
  projects: number;
  workEvents: number;
  decisions: number;
  supersededDecisions: number;
  projectStates: number;
  nextActions: number;
}

export interface MemoryMergeResult {
  snapshot: MemoryStoreSnapshot;
  inserted: MemoryMergeCounts;
}

export function decisionTopicKey(topic: string): string {
  return topic.trim().toLocaleLowerCase().split(/[\\/]/u).filter(Boolean).at(-1) ?? topic;
}

/** Merge an extraction idempotently while retaining decision history. */
export function mergeMemoryExtraction(
  current: MemoryStoreSnapshot,
  extraction: MemoryExtractionResult,
): MemoryMergeResult {
  const snapshot = structuredClone(current);
  const inserted: MemoryMergeCounts = {
    projects: 0,
    workEvents: 0,
    decisions: 0,
    supersededDecisions: 0,
    projectStates: 0,
    nextActions: 0,
  };

  const project = snapshot.projects.find((item) => item.projectId === extraction.project.projectId);
  if (project) {
    project.firstSeenAt = earlier(project.firstSeenAt, extraction.project.firstSeenAt);
    project.lastSeenAt = later(project.lastSeenAt, extraction.project.lastSeenAt);
    project.currentSummary = extraction.project.currentSummary ?? project.currentSummary;
    project.repoPath ??= extraction.project.repoPath;
    project.repoUrl ??= extraction.project.repoUrl;
    project.worktreePath ??= extraction.project.worktreePath;
    project.metadata = { ...project.metadata, ...extraction.project.metadata };
  } else {
    snapshot.projects.push(structuredClone(extraction.project));
    inserted.projects += 1;
  }

  const eventsByFingerprint = new Map(snapshot.workEvents.map((event) => [event.fingerprint, event]));
  for (const event of extraction.workEvents) {
    if (eventsByFingerprint.has(event.fingerprint)) continue;
    snapshot.workEvents.push(structuredClone(event));
    eventsByFingerprint.set(event.fingerprint, event);
    inserted.workEvents += 1;
  }

  const decisionsByFingerprint = new Map(snapshot.decisions.map((decision) => [decision.fingerprint, decision]));
  for (const decision of extraction.decisions) {
    if (decisionsByFingerprint.has(decision.fingerprint)) continue;
    if (decision.status === 'ACTIVE' && snapshot.decisions.some(
      (previous) =>
        previous.projectId === decision.projectId &&
        decisionTopicKey(previous.topic) === decisionTopicKey(decision.topic) &&
        previous.status === 'ACTIVE' &&
        normalizeMemoryText(previous.decision) === normalizeMemoryText(decision.decision),
    )) continue;
    const active = snapshot.decisions.filter(
      (previous) =>
        previous.projectId === decision.projectId &&
        decisionTopicKey(previous.topic) === decisionTopicKey(decision.topic) &&
        previous.status === 'ACTIVE' &&
        normalizeMemoryText(previous.decision) !== normalizeMemoryText(decision.decision),
    );
    const newer = active
      .filter((previous) => previous.validFrom > decision.validFrom)
      .sort((left, right) => right.validFrom.localeCompare(left.validFrom))[0];
    const nextDecision = newer
      ? { ...decision, status: 'SUPERSEDED' as const, validTo: newer.validFrom }
      : decision;
    if (!newer) {
      for (const previous of active) {
        previous.status = 'SUPERSEDED';
        previous.validTo = decision.validFrom;
        inserted.supersededDecisions += 1;
      }
    }
    snapshot.decisions.push(structuredClone(nextDecision));
    decisionsByFingerprint.set(decision.fingerprint, nextDecision);
    inserted.decisions += 1;
  }

  if (extraction.projectState) {
    const currentState = snapshot.projectStates.find(
      (state) => state.projectId === extraction.projectState?.projectId,
    );
    if (!currentState) {
      snapshot.projectStates.push(structuredClone(extraction.projectState));
      inserted.projectStates += 1;
    } else if (extraction.projectState.updatedAt >= currentState.updatedAt) {
      Object.assign(currentState, structuredClone(extraction.projectState));
      inserted.projectStates += 1;
    }
  }

  const actionsByFingerprint = new Map(snapshot.nextActions.map((action) => [action.fingerprint, action]));
  for (const action of extraction.nextActions) {
    if (actionsByFingerprint.has(action.fingerprint)) continue;
    snapshot.nextActions.push(structuredClone(action));
    actionsByFingerprint.set(action.fingerprint, action);
    inserted.nextActions += 1;
  }

  snapshot.projects.sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
  snapshot.workEvents.sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
  snapshot.decisions.sort((left, right) => right.validFrom.localeCompare(left.validFrom));
  snapshot.nextActions.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return { snapshot, inserted };
}

function earlier(left: string, right: string): string {
  return left <= right ? left : right;
}

function later(left: string, right: string): string {
  return left >= right ? left : right;
}

export function sortMemoryEvents(events: MemoryWorkEvent[]): MemoryWorkEvent[] {
  return events.slice().sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
}

export function sortMemoryDecisions(decisions: MemoryDecision[]): MemoryDecision[] {
  return decisions.slice().sort((left, right) => right.validFrom.localeCompare(left.validFrom));
}

export function sortMemoryActions(actions: MemoryNextAction[]): MemoryNextAction[] {
  return actions.slice().sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
