import { describe, expect, it } from "vitest";
import type {
  MemoryExtractionResult,
  MemoryProject,
  MemorySourceReference,
} from "@aiusage/memory-core";
import {
  applyMemoryExtraction,
  buildCloudMemoryPayload,
  emptyMemoryDatabase,
} from "../memory-store.js";

const sourceRef: MemorySourceReference = {
  source: "pi",
  sourceSessionId: "session-1",
  occurredAt: "2026-09-08T12:00:00.000Z",
  sourceRecordId: "record-1",
  sourcePath: "/Users/alice/.pi/sessions/session-1.jsonl",
  projectPath: "/Users/alice/workspace/demo",
};

const project: MemoryProject = {
  projectId: "project_demo",
  projectKey: "remote:github.com/example/demo",
  projectName: "demo",
  repoPath: "/Users/alice/workspace/demo",
  repoUrl: "https://github.com/example/demo.git",
  firstSeenAt: sourceRef.occurredAt,
  lastSeenAt: sourceRef.occurredAt,
  status: "ACTIVE",
};

function extraction(decision: string): MemoryExtractionResult {
  const event = {
    id: "memory_event_1",
    fingerprint: "event-1",
    source: "pi",
    sourceSessionId: sourceRef.sourceSessionId,
    projectId: project.projectId,
    eventType: "decision" as const,
    title: decision,
    summary: decision,
    occurredAt: sourceRef.occurredAt,
    sourceRef,
    importance: 0.95,
    confidence: 0.72,
    metadata: {
      command: "git status",
      projectPath: project.repoPath,
    },
    createdAt: sourceRef.occurredAt,
  };

  return {
    project,
    workEvents: [event],
    decisions: [{
      id: `memory_decision_${decision}`,
      fingerprint: `decision-${decision}`,
      projectId: project.projectId,
      topic: "architecture",
      decision,
      reason: "coverage",
      status: "ACTIVE",
      validFrom: sourceRef.occurredAt,
      sourceEventId: event.id,
      sourceRef,
      confidence: 0.72,
      createdAt: sourceRef.occurredAt,
    }],
    projectState: {
      projectId: project.projectId,
      summary: decision,
      currentPhase: "decision",
      recentProgress: [decision],
      blockers: [],
      updatedAt: sourceRef.occurredAt,
      sourceEventId: event.id,
      sourceRef,
    },
    nextActions: [{
      id: "memory_action_1",
      fingerprint: "action-1",
      projectId: project.projectId,
      content: "验证方案",
      status: "OPEN",
      sourceEventId: event.id,
      sourceRef,
      createdAt: sourceRef.occurredAt,
    }],
  };
}

describe("memory store", () => {
  it("is idempotent and preserves decision history when a topic evolves", () => {
    const database = emptyMemoryDatabase();
    const first = extraction("采用方案 A");
    const second = extraction("采用方案 B");

    expect(applyMemoryExtraction(database, first)).toMatchObject({
      projects: 1,
      workEvents: 1,
      decisions: 1,
      nextActions: 1,
    });
    expect(applyMemoryExtraction(database, first)).toMatchObject({
      workEvents: 0,
      decisions: 0,
      nextActions: 0,
    });
    expect(applyMemoryExtraction(database, second)).toMatchObject({
      workEvents: 0,
      decisions: 1,
      supersededDecisions: 1,
      nextActions: 0,
    });

    expect(database.decisions.map((item) => [item.decision, item.status])).toEqual([
      ["采用方案 A", "SUPERSEDED"],
      ["采用方案 B", "ACTIVE"],
    ]);
    expect(database.workEvents).toHaveLength(1);
    expect(database.nextActions).toHaveLength(1);

    const outOfOrder = emptyMemoryDatabase();
    const older = extraction("采用方案 A");
    const newer = extraction("采用方案 B");
    older.decisions[0]!.validFrom = "2026-09-08T12:00:00.000Z";
    newer.decisions[0]!.validFrom = "2026-09-08T13:00:00.000Z";
    applyMemoryExtraction(outOfOrder, newer);
    const late = applyMemoryExtraction(outOfOrder, older);
    expect(late.supersededDecisions).toBe(0);
    expect(outOfOrder.decisions.map((item) => [item.decision, item.status])).toEqual([
      ["采用方案 B", "ACTIVE"],
      ["采用方案 A", "SUPERSEDED"],
    ]);
  });

  it("removes local provenance and paths from cloud payloads", () => {
    const payload = buildCloudMemoryPayload([extraction("采用方案 A")]);
    expect(payload.projects[0]).not.toHaveProperty("repoPath");
    expect(payload.projects[0]).not.toHaveProperty("repoUrl");
    expect(payload.workEvents[0]?.sourceRef).not.toHaveProperty("sourcePath");
    expect(payload.workEvents[0]?.sourceRef).not.toHaveProperty("projectPath");
    expect(payload.workEvents[0]?.metadata).not.toHaveProperty("command");
    expect(payload.workEvents[0]?.metadata).not.toHaveProperty("projectPath");
  });
});
