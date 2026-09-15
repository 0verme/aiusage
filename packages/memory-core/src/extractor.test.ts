import { describe, expect, it } from "vitest";
import { resolveProjectIdentity } from "./project-identity.js";
import { RuleBasedMemoryExtractor } from "./extractor.js";
import type { NormalizedSession } from "./types.js";

function session(texts: string[]): NormalizedSession {
  const project = resolveProjectIdentity({
    cwd: "/workspace/lakehouse-toolkit-wt-45",
    repositoryRoot: "/workspace/lakehouse-toolkit",
    gitCommonDir: "/workspace/lakehouse-toolkit/.git",
    remoteUrl: "git@github.com:0verme/lakehouse-toolkit.git",
  });
  return {
    source: "pi",
    sessionId: "session-1",
    project,
    startedAt: "2026-09-08T12:00:00.000Z",
    endedAt: "2026-09-08T12:05:00.000Z",
    models: ["gpt-5.6"],
    toolNames: ["bash", "edit"],
    messages: texts.map((text, index) => ({
      id: `message-${index}`,
      role: "user",
      text,
      timestamp: `2026-09-08T12:0${index}:00.000Z`,
      sourceRef: {
        source: "pi",
        sourceSessionId: "session-1",
        occurredAt: `2026-09-08T12:0${index}:00.000Z`,
        sourceRecordId: `message-${index}`,
        projectPath: "/workspace/lakehouse-toolkit-wt-45",
      },
    })),
  };
}

describe("RuleBasedMemoryExtractor", () => {
  it("extracts work, decision, state and next action without turning chatter into memory", () => {
    const result = new RuleBasedMemoryExtractor().extract(
      session([
        "设计 DWS schema，决定不引入 platform/catalog，因为元数据覆盖率不足。",
        "下一步：建立 DWS 表；验证 DEV214。",
        "好的，谢谢。",
      ]),
    );

    expect(result.project.projectName).toBe("lakehouse-toolkit");
    expect(result.workEvents.length).toBeGreaterThanOrEqual(2);
    expect(result.decisions[0]).toMatchObject({
      topic: "platform/catalog",
      status: "ACTIVE",
    });
    expect(result.decisions[0]?.reason).toContain("元数据覆盖率不足");
    expect(result.nextActions.map((action) => action.content)).toEqual([
      "建立 DWS 表",
      "验证 DEV214",
    ]);
    expect(result.projectState?.currentPhase).toBe("planning");
    expect(result.workEvents.map((event) => event.title)).not.toContain("好的，谢谢");
  });
});
