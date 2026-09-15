import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type {
  NormalizedMessage,
  NormalizedSession,
  NormalizedToolCall,
  ProjectIdentity,
} from "@aiusage/memory-core";
import { getCodexBaseDir } from "./scanners/codex.js";
import { getClaudeProjectDirs } from "./scanners/claude-paths.js";
import { resolvePiSessionDirs } from "./scanners/pi.js";
import {
  dateKey,
  fileModifiedTs,
  parseTs,
  resolveProjectFields,
  walkFiles,
} from "./scanners/utils.js";
import { resolveMemoryProject, type MemoryProjectResolverOptions } from "./memory-project.js";

const MAX_LINE_BYTES = 64 * 1024 * 1024;

export interface ScanMemorySessionsOptions extends MemoryProjectResolverOptions {
  dates: readonly string[];
  codexDir?: string;
  claudeProjectsDirs?: string[];
  piDir?: string;
}

interface SessionBuilder {
  source: "codex" | "claude-code" | "pi";
  sessionId: string;
  cwd?: string;
  fallbackCwd?: string;
  startedAt?: string;
  endedAt?: string;
  models: Set<string>;
  toolNames: Set<string>;
  messages: NormalizedMessage[];
}

export async function scanMemorySessions(
  options: ScanMemorySessionsOptions,
): Promise<NormalizedSession[]> {
  const dates = new Set(options.dates);
  if (dates.size === 0) return [];

  const [codexFiles, claudeFiles, piFiles] = await Promise.all([
    collectCodexFiles(options.codexDir),
    collectClaudeFiles(options.claudeProjectsDirs),
    collectPiFiles(options.piDir),
  ]);
  const builders = [
    ...(await Promise.all(codexFiles.map((filePath) => parseCodexFile(filePath, dates)))),
    ...(await Promise.all(claudeFiles.map((job) => parseClaudeFile(job.filePath, job.fallbackCwd, dates)))),
    ...(await Promise.all(piFiles.map((filePath) => parsePiFile(filePath, dates)))),
  ];

  const merged = mergeSessionBuilders(builders);
  const projectCache = new Map<string, Promise<ProjectIdentity>>();
  return Promise.all(
    merged
      .filter((builder) => builder.messages.length > 0)
      .map(async (builder) => {
        const cwd = builder.cwd || builder.fallbackCwd || "unknown";
        let projectPromise = projectCache.get(cwd);
        if (!projectPromise) {
          projectPromise = resolveMemoryProject(cwd, options);
          projectCache.set(cwd, projectPromise);
        }
        const project = await projectPromise;
        return finalizeSession(builder, project);
      }),
  );
}

async function collectCodexFiles(codexDir?: string): Promise<string[]> {
  return walkFiles(join(getCodexBaseDir(codexDir), "sessions"), ".jsonl");
}

async function collectPiFiles(piDir?: string): Promise<string[]> {
  const directories = resolvePiSessionDirs(piDir);
  return [
    ...new Set(
      (
        await Promise.all(directories.map((directory) => walkFiles(directory, ".jsonl")))
      ).flat(),
    ),
  ];
}

async function collectClaudeFiles(
  configuredProjectsDirs?: string[],
): Promise<Array<{ filePath: string; fallbackCwd: string }>> {
  const jobs: Array<{ filePath: string; fallbackCwd: string }> = [];
  for (const baseDir of getClaudeProjectDirs({ configuredProjectsDirs })) {
    let entries;
    try {
      entries = await readdir(baseDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projectDir = join(baseDir, entry.name);
      const files = await walkFiles(projectDir, ".jsonl");
      for (const filePath of files) jobs.push({ filePath, fallbackCwd: entry.name });
    }
  }
  return jobs;
}

async function parseCodexFile(
  filePath: string,
  dates: Set<string>,
): Promise<SessionBuilder> {
  const builder = createBuilder("codex", basename(filePath, ".jsonl"));
  const fallback = await fileModifiedTs(filePath);
  await readJsonl(filePath, (value, lineNumber) => {
    const record = asRecord(value);
    if (!record) return;
    const payload = asRecord(record.payload);
    const type = stringValue(record.type);

    if (type === "session_meta") {
      builder.sessionId = stringValue(payload?.id) || builder.sessionId;
      builder.cwd = stringValue(payload?.cwd) || builder.cwd;
      return;
    }
    if (type === "turn_context") {
      builder.cwd = stringValue(payload?.cwd) || builder.cwd;
      const model = stringValue(payload?.model);
      if (model) builder.models.add(model);
      return;
    }

    const timestamp = parseTs(stringValue(record.timestamp)) ?? fallback;
    if (!timestamp || !dates.has(dateKey(timestamp))) return;
    const timestampText = timestamp.toISOString();
    const ref = sourceRef("codex", builder, timestampText, filePath, lineNumber);

    if (type === "event_msg" && payload?.type === "user_message") {
      appendMessage(builder, {
        id: stringValue(payload.id),
        role: "user",
        text: stringValue(payload.message),
        timestamp: timestampText,
        sourceRef: ref,
      });
      return;
    }

    if (type !== "response_item") return;
    const item = asRecord(payload?.item) ?? payload;
    if (!item) return;
    const itemType = stringValue(item.type);
    const model = stringValue(item.model);
    if (model) builder.models.add(model);

    if (itemType === "message") {
      const role = stringValue(item.role);
      if (role !== "user" && role !== "assistant") return;
      appendMessage(builder, {
        id: stringValue(item.id),
        role,
        text: extractText(item.content),
        timestamp: timestampText,
        model,
        sourceRef: ref,
      });
      return;
    }

    const toolName =
      itemType === "function_call" || itemType === "custom_tool_call"
        ? stringValue(item.name)
        : itemType?.endsWith("_call")
          ? itemType
          : undefined;
    if (!toolName) return;
    builder.toolNames.add(toolName);
    appendMessage(builder, {
      id: stringValue(item.call_id),
      role: "assistant",
      timestamp: timestampText,
      model,
      toolCalls: [
        {
          id: stringValue(item.call_id),
          name: toolName,
          arguments: parseJsonObject(item.arguments),
        },
      ],
      sourceRef: ref,
    });
  });
  return builder;
}

async function parseClaudeFile(
  filePath: string,
  fallbackCwd: string,
  dates: Set<string>,
): Promise<SessionBuilder> {
  const builder = createBuilder("claude-code", basename(filePath, ".jsonl"));
  builder.fallbackCwd = fallbackCwd;
  const fallback = await fileModifiedTs(filePath);
  await readJsonl(filePath, (value, lineNumber) => {
    const record = asRecord(value);
    if (!record) return;
    const message = asRecord(record.message);
    const timestamp = parseTs(stringValue(record.timestamp)) ?? fallback;
    if (!timestamp || !dates.has(dateKey(timestamp))) return;
    const timestampText = timestamp.toISOString();
    const sessionId = stringValue(record.sessionId);
    if (sessionId) builder.sessionId = sessionId;
    builder.cwd = stringValue(record.cwd) || builder.cwd;
    const model = stringValue(message?.model);
    if (model) builder.models.add(model);
    const ref = sourceRef("claude-code", builder, timestampText, filePath, lineNumber);
    const role = stringValue(message?.role);
    if (role !== "user" && role !== "assistant") return;
    if (role === "user" && record.isMeta === true) return;

    const content = message?.content;
    const toolCalls = extractClaudeTools(content);
    for (const tool of toolCalls) builder.toolNames.add(tool.name);
    appendMessage(builder, {
      id: stringValue(record.uuid) || stringValue(message?.id),
      role,
      text: extractText(content),
      timestamp: timestampText,
      model,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      sourceRef: ref,
    });
  });
  return builder;
}

async function parsePiFile(
  filePath: string,
  dates: Set<string>,
): Promise<SessionBuilder> {
  const builder = createBuilder("pi", basename(filePath, ".jsonl"));
  builder.fallbackCwd = decodePiCwd(basename(dirname(filePath)));
  const fallback = await fileModifiedTs(filePath);
  await readJsonl(filePath, (value, lineNumber) => {
    const record = asRecord(value);
    if (!record) return;
    if (record.type === "session") {
      builder.sessionId = stringValue(record.id) || builder.sessionId;
      builder.cwd = stringValue(record.cwd) || builder.cwd;
      return;
    }
    if (record.type !== "message") return;
    const message = asRecord(record.message);
    if (!message) return;
    const role = stringValue(message.role);
    if (role !== "user" && role !== "assistant") return;
    const timestamp = parseTs(stringValue(record.timestamp)) ?? fallback;
    if (!timestamp || !dates.has(dateKey(timestamp))) return;
    const timestampText = timestamp.toISOString();
    const model = stringValue(message.model);
    if (model) builder.models.add(model);
    const toolCalls = role === "assistant" ? extractPiTools(message.content) : [];
    for (const tool of toolCalls) builder.toolNames.add(tool.name);
    appendMessage(builder, {
      id: stringValue(record.id),
      role,
      text: extractText(message.content),
      timestamp: timestampText,
      model,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      sourceRef: sourceRef("pi", builder, timestampText, filePath, lineNumber),
    });
  });
  return builder;
}

function createBuilder(
  source: SessionBuilder["source"],
  sessionId: string,
): SessionBuilder {
  return {
    source,
    sessionId,
    models: new Set(),
    toolNames: new Set(),
    messages: [],
  };
}

function appendMessage(builder: SessionBuilder, message: NormalizedMessage): void {
  const text = message.text?.trim();
  const hasTool = (message.toolCalls?.length ?? 0) > 0;
  if (!text && !hasTool) return;
  const duplicate = builder.messages.some((existing) =>
    (message.id && existing.id === message.id) ||
    (!message.id && existing.role === message.role && existing.timestamp === message.timestamp && existing.text === message.text),
  );
  if (duplicate) return;
  builder.messages.push({ ...message, text: text || undefined });
  if (!builder.startedAt || message.timestamp < builder.startedAt) builder.startedAt = message.timestamp;
  if (!builder.endedAt || message.timestamp > builder.endedAt) builder.endedAt = message.timestamp;
}

function mergeSessionBuilders(builders: SessionBuilder[]): SessionBuilder[] {
  const result = new Map<string, SessionBuilder>();
  for (const builder of builders) {
    const key = `${builder.source}:${builder.sessionId}`;
    const existing = result.get(key);
    if (!existing) {
      result.set(key, builder);
      continue;
    }
    existing.cwd ||= builder.cwd;
    existing.fallbackCwd ||= builder.fallbackCwd;
    for (const model of builder.models) existing.models.add(model);
    for (const tool of builder.toolNames) existing.toolNames.add(tool);
    for (const message of builder.messages) appendMessage(existing, message);
    if (builder.startedAt && (!existing.startedAt || builder.startedAt < existing.startedAt)) existing.startedAt = builder.startedAt;
    if (builder.endedAt && (!existing.endedAt || builder.endedAt > existing.endedAt)) existing.endedAt = builder.endedAt;
  }
  return [...result.values()];
}

function finalizeSession(builder: SessionBuilder, project: ProjectIdentity): NormalizedSession {
  const messages = builder.messages
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .map((message) => ({
      ...message,
      sourceRef: { ...message.sourceRef, sourceSessionId: builder.sessionId },
    }));
  const startedAt = builder.startedAt || messages[0]?.timestamp || new Date(0).toISOString();
  const endedAt = builder.endedAt || messages.at(-1)?.timestamp || startedAt;
  return {
    source: builder.source,
    sessionId: builder.sessionId,
    project,
    startedAt,
    endedAt,
    models: [...builder.models].sort(),
    toolNames: [...builder.toolNames].sort(),
    messages,
  };
}

function sourceRef(
  source: SessionBuilder["source"],
  builder: SessionBuilder,
  occurredAt: string,
  sourcePath: string,
  lineNumber: number,
) {
  return {
    source,
    sourceSessionId: builder.sessionId,
    occurredAt,
    sourcePath,
    lineStart: lineNumber,
    lineEnd: lineNumber,
  };
}

async function readJsonl(
  filePath: string,
  onRecord: (value: unknown, lineNumber: number) => void,
): Promise<void> {
  let input;
  try {
    input = createReadStream(filePath, { encoding: "utf-8" });
  } catch {
    return;
  }
  try {
    const reader = createInterface({ input, crlfDelay: Infinity });
    let lineNumber = 0;
    for await (const line of reader) {
      lineNumber += 1;
      if (!line || Buffer.byteLength(line) > MAX_LINE_BYTES) continue;
      try {
        onRecord(JSON.parse(line), lineNumber);
      } catch {
        // Individual corrupt records must not hide the rest of a session.
      }
    }
  } catch {
    // Files may be rotated while a scan is running.
  } finally {
    input.destroy();
  }
}

function extractText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!Array.isArray(value)) return undefined;
  const text = value
    .map((block) => {
      const item = asRecord(block);
      if (!item) return "";
      return stringValue(item.text) || stringValue(item.content) || "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
  return text || undefined;
}

function extractClaudeTools(value: unknown): NormalizedToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((block) => {
    const item = asRecord(block);
    if (!item || item.type !== "tool_use") return [];
    return [{
      id: stringValue(item.id),
      name: stringValue(item.name) || "unknown",
      arguments: asRecord(item.input),
    }];
  });
}

function extractPiTools(value: unknown): NormalizedToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((block) => {
    const item = asRecord(block);
    if (!item || item.type !== "toolCall") return [];
    return [{
      id: stringValue(item.id),
      name: stringValue(item.name) || "unknown",
      arguments: asRecord(item.arguments),
    }];
  });
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return asRecord(value);
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function decodePiCwd(encoded: string): string | undefined {
  if (!encoded || encoded === "sessions") return undefined;
  const value = encoded.replace(/^--/, "").replace(/--$/, "");
  if (!value) return undefined;
  return value.replaceAll("--", "/");
}
