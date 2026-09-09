import {
  fingerprint,
  memoryId,
  normalizeMemoryText,
} from "./fingerprint.js";
import type {
  MemoryDecision,
  MemoryEventType,
  MemoryExtractionResult,
  MemoryExtractor,
  MemoryNextAction,
  MemoryProject,
  MemoryProjectState,
  MemorySourceReference,
  MemoryWorkEvent,
  NormalizedMessage,
  NormalizedSession,
} from "./types.js";

const MAX_TITLE_LENGTH = 96;
const MAX_SUMMARY_LENGTH = 280;
const MAX_ACTION_LENGTH = 180;
const RULE_CONFIDENCE = 0.72;

/**
 * A deliberately conservative extractor for the first Memory vertical slice.
 * It emits structured work records only for messages carrying project-work
 * signals; it does not turn every conversation line into a permanent memory.
 */
export class RuleBasedMemoryExtractor implements MemoryExtractor {
  extract(session: NormalizedSession): MemoryExtractionResult {
    const project = toMemoryProject(session);
    const events: MemoryWorkEvent[] = [];
    const decisions: MemoryDecision[] = [];
    const nextActions: MemoryNextAction[] = [];
    const actionFingerprints = new Set<string>();
    const meaningful = session.messages
      .filter((message) => isMeaningful(message))
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp));

    for (const message of meaningful) {
      const text = compactText(message.text ?? "");
      if (!text) continue;
      const eventType = classifyEvent(text);
      if (!eventType) continue;

      const eventFingerprint = fingerprint([
        session.source,
        session.sessionId,
        eventType,
        message.id ?? message.sourceRef.sourceRecordId ?? message.timestamp,
        normalizeMemoryText(text),
      ]);
      const event: MemoryWorkEvent = {
        id: memoryId("event", eventFingerprint),
        fingerprint: eventFingerprint,
        source: session.source,
        sourceSessionId: session.sessionId,
        projectId: project.projectId,
        eventType,
        title: titleFromText(text),
        summary: summaryFromText(text, session.toolNames),
        occurredAt: message.timestamp,
        sourceRef: message.sourceRef,
        importance: importanceFor(eventType, text),
        confidence: RULE_CONFIDENCE,
        category: eventType,
        metadata: {
          ...(message.model ? { model: message.model } : {}),
          ...(session.toolNames.length > 0
            ? { toolNames: session.toolNames.slice(0, 12) }
            : {}),
        },
        createdAt: new Date().toISOString(),
      };
      events.push(event);

      if (isDecisionText(text)) {
        const decisionFingerprint = fingerprint([
          project.projectId,
          decisionTopic(text),
          normalizeMemoryText(decisionText(text)),
        ]);
        decisions.push({
          id: memoryId("decision", decisionFingerprint),
          fingerprint: decisionFingerprint,
          projectId: project.projectId,
          topic: decisionTopic(text),
          decision: decisionText(text),
          reason: decisionReason(text),
          status: "ACTIVE",
          validFrom: message.timestamp,
          sourceEventId: event.id,
          sourceRef: message.sourceRef,
          confidence: RULE_CONFIDENCE,
          createdAt: new Date().toISOString(),
        });
      }

      for (const action of extractActions(text)) {
        const actionFingerprint = fingerprint([
          project.projectId,
          normalizeMemoryText(action),
        ]);
        if (actionFingerprints.has(actionFingerprint)) continue;
        actionFingerprints.add(actionFingerprint);
        nextActions.push({
          id: memoryId("action", actionFingerprint),
          fingerprint: actionFingerprint,
          projectId: project.projectId,
          content: action,
          status: "OPEN",
          sourceEventId: event.id,
          sourceRef: message.sourceRef,
          createdAt: new Date().toISOString(),
        });
      }
    }

    const orderedEvents = events.sort((left, right) =>
      right.occurredAt.localeCompare(left.occurredAt),
    );
    const latest = orderedEvents[0];
    const projectState = latest
      ? buildProjectState(project.projectId, orderedEvents, meaningful, latest)
      : undefined;

    return {
      project: {
        ...project,
        currentSummary: projectState?.summary,
      },
      workEvents: orderedEvents,
      decisions: dedupeDecisions(decisions),
      projectState,
      nextActions,
    };
  }
}

function toMemoryProject(session: NormalizedSession): MemoryProject {
  return {
    ...session.project,
    firstSeenAt: session.startedAt,
    lastSeenAt: session.endedAt,
    status: "ACTIVE",
  };
}

function isMeaningful(message: NormalizedMessage): boolean {
  const text = compactText(message.text ?? "");
  if (text.length < 8) return false;
  if (/^(ok|okay|thanks|thx|好的|好|收到|继续|嗯|好的谢谢)[.!。！!]?$/i.test(text))
    return false;
  return Boolean(classifyEvent(text) || isDecisionText(text) || extractActions(text).length);
}

function classifyEvent(text: string): MemoryEventType | undefined {
  if (isDecisionText(text)) return "decision";
  if (/(bug|error|exception|失败|报错|修复|排查|debug|调试|问题)/i.test(text))
    return "debugging";
  if (/(plan|planning|规划|计划|方案|架构|设计|下一步)/i.test(text))
    return "planning";
  if (/(test|测试|验证|vitest|pytest|coverage|回归)/i.test(text)) return "testing";
  if (/(release|发布|deploy|部署|merge|合并|tag|上线)/i.test(text)) return "release";
  if (/(git|commit|branch|分支|worktree|pr\b)/i.test(text)) return "git";
  if (/(readme|documentation|docs|文档|说明)/i.test(text)) return "documentation";
  if (/(research|调查|研究|查找|比较|compare|文档|资料)/i.test(text)) return "research";
  if (/(review|审查|审计|review|检查代码)/i.test(text)) return "review";
  if (/(implement|实现|新增|添加|修改|重构|编写|写一个|开发|build|create)/i.test(text))
    return "implementation";
  return undefined;
}

function isDecisionText(text: string): boolean {
  return /(决定|选择|采用|不引入|引入|改为|保留|取舍|方案|decision|decide|choose|chosen|avoid|don't use|do not use|use .+ instead)/i.test(
    text,
  );
}

function decisionTopic(text: string): string {
  const explicit = text.match(/(?:topic|主题)\s*[:：]\s*([^。.!！\n]+)/i)?.[1];
  if (explicit) return slug(explicit);

  const known = [
    "platform/catalog",
    "platform",
    "catalog",
    "lineage",
    "schema",
    "api",
    "database",
    "d1",
    "privacy",
    "memory",
    "dashboard",
  ];
  const lower = text.toLocaleLowerCase();
  const match = known.find((candidate) => lower.includes(candidate));
  if (match) return match;

  const cleaned = text
    .replace(/不引入|引入|决定|选择|采用|改为|保留|决定使用|decision|decide|choose|chosen/gi, " ")
    .replace(/[^\p{L}\p{N}\s/_-]+/gu, " ")
    .trim();
  return slug(cleaned.slice(0, 72)) || "project-architecture";
}

function decisionText(text: string): string {
  return sentence(text);
}

function decisionReason(text: string): string {
  const reason = text.match(/(?:因为|由于|原因是|基于|because|since|as)\s*([^。.!！\n]+)/i)?.[1];
  return reason ? truncate(reason.trim(), MAX_SUMMARY_LENGTH) : "未在来源消息中明确说明";
}

function extractActions(text: string): string[] {
  const explicit = /(?:下一步|next(?: step)?|todo|待办|计划|需要|请)\s*[:：]?\s*(.+)/i.exec(text);
  if (!explicit) return [];
  return explicit[1]
    .split(/[\n；;。]/)
    .map((value) => value.replace(/^[-*\d.)\s]+/, "").trim())
    .filter((value) => value.length >= 4)
    .map((value) => truncate(value, MAX_ACTION_LENGTH))
    .slice(0, 5);
}

function buildProjectState(
  projectId: string,
  events: MemoryWorkEvent[],
  messages: NormalizedMessage[],
  latest: MemoryWorkEvent,
): MemoryProjectState {
  const blockers = messages
    .map((message) => compactText(message.text ?? ""))
    .filter((text) => /(blocker|blocked|阻塞|卡住|无法|不能|失败|报错)/i.test(text))
    .map((text) => truncate(sentence(text), MAX_SUMMARY_LENGTH))
    .slice(0, 3);

  return {
    projectId,
    summary: latest.summary,
    currentPhase: latest.eventType,
    recentProgress: events.slice(0, 3).map((event) => event.summary),
    blockers,
    updatedAt: latest.occurredAt,
    sourceEventId: latest.id,
    sourceRef: latest.sourceRef,
  };
}

function dedupeDecisions(decisions: MemoryDecision[]): MemoryDecision[] {
  const seen = new Set<string>();
  return decisions.filter((decision) => {
    if (seen.has(decision.fingerprint)) return false;
    seen.add(decision.fingerprint);
    return true;
  });
}

function importanceFor(type: MemoryEventType, text: string): number {
  if (type === "decision") return 0.95;
  if (/(schema|architecture|migration|api|database|repo|project|范围|边界)/i.test(text)) return 0.88;
  if (type === "debugging" || type === "release") return 0.82;
  return 0.68;
}

function titleFromText(text: string): string {
  const firstLine = text.split(/\n|。|！|!/)[0]?.trim() || text;
  return truncate(firstLine, MAX_TITLE_LENGTH);
}

function summaryFromText(text: string, toolNames: string[]): string {
  const base = truncate(sentence(text), MAX_SUMMARY_LENGTH);
  if (toolNames.length === 0) return base;
  return `${base}（工具：${toolNames.slice(0, 4).join(", ")}）`;
}

function sentence(value: string): string {
  return truncate(compactText(value), MAX_SUMMARY_LENGTH);
}

function compactText(value: string): string {
  return value.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trim()}…`;
}

function slug(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72) || "project-work";
}
