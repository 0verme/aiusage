import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { IngestBreakdown } from '@aiusage/shared';
import { dateKey, emptyResult, initDateMap, parseTs, resolveProjectFields } from './utils.js';

const SESSION_FILES = ['summary.json', 'events.jsonl', 'signals.json', 'chat_history.jsonl', 'updates.jsonl'] as const;

type Json = Record<string, unknown>;

interface TokenEstimate {
  input: number;
  output: number;
  reasoning: number;
  cached: number;
}

/**
 * Scan Grok Build's local session metadata. auth.json is intentionally not
 * enumerated or read. Grok Build does not currently persist authoritative
 * billable usage, therefore message-text token counts are only a heuristic.
 *
 * Real log shape (as of 2026-07):
 * - events.jsonl uses `ts` (ISO) + `type: turn_started`
 * - chat_history.jsonl uses `type` as role and often `content: [{type,text}]`
 * - assistant rows may have empty content but large `tool_calls` (count as output)
 * - updates.jsonl has agent_thought_chunk (reasoning) and streaming message chunks
 */
export async function scanGrokBuildDates(
  targetDates: string[],
  baseDir?: string,
  projectAliases?: Record<string, string>,
): Promise<Map<string, IngestBreakdown[]>> {
  const dates = new Set(targetDates);
  const grokHome = baseDir ?? process.env.GROK_HOME?.trim() ?? join(homedir(), '.grok');
  const sessionsDir = join(grokHome, 'sessions');
  const grouped = initDateMap(dates);
  let projectDirs;
  try { projectDirs = await readdir(sessionsDir, { withFileTypes: true }); } catch { return emptyResult(dates); }

  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) continue;
    let sessionDirs;
    try { sessionDirs = await readdir(join(sessionsDir, projectDir.name), { withFileTypes: true }); } catch { continue; }
    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory()) continue;
      await scanSession(join(sessionsDir, projectDir.name, sessionDir.name), projectDir.name, sessionDir.name, dates, grouped, projectAliases);
    }
  }
  return new Map([...grouped.entries()].map(([day, values]) => [day, [...values.values()]]));
}

async function scanSession(
  dir: string,
  encodedCwd: string,
  sessionId: string,
  targetDates: Set<string>,
  grouped: Map<string, Map<string, IngestBreakdown>>,
  aliases?: Record<string, string>,
): Promise<void> {
  const records: Array<{ file: string; record: Json }> = [];
  for (const name of SESSION_FILES) {
    const content = await safeRead(join(dir, name));
    if (!content) continue;
    if (name.endsWith('.jsonl')) {
      for (const line of content.split('\n')) {
        try { if (line.trim()) records.push({ file: name, record: JSON.parse(line) as Json }); } catch { /* malformed local record */ }
      }
    } else {
      try { records.push({ file: name, record: JSON.parse(content) as Json }); } catch { /* malformed local record */ }
    }
  }
  if (records.length === 0) return;

  const cwd = records.map(({ record }) => findString(record, ['cwd', 'working_directory', 'workingDirectory'])).find(Boolean) ?? decodeCwd(encodedCwd);
  const fields = resolveProjectFields(cwd, aliases);
  const model = records.map(({ record }) => findString(record, [
    'model_id', 'modelId', 'current_model_id', 'currentModelId', 'primaryModelId', 'primary_model_id',
  ])).find(Boolean) ?? 'grok-4.5';

  const turns = records.filter(({ file, record }) => file === 'events.jsonl' && eventType(record) === 'turn_started');
  const turnDays = new Map<string, number>();
  for (const { record } of turns) {
    const day = recordDate(record);
    if (day && targetDates.has(day)) turnDays.set(day, (turnDays.get(day) ?? 0) + 1);
  }

  const fallbackDate =
    records.map(({ record }) => recordDate(record)).find(Boolean)
    ?? records.map(({ record }) => recordDateTopLevel(record)).find(Boolean);
  if (turnDays.size === 0 && fallbackDate && targetDates.has(fallbackDate)) turnDays.set(fallbackDate, 0);
  if (turnDays.size === 0) return;

  const key = `${model}|${fields.project}`;
  const tokenDate = [...turnDays.keys()][0];
  for (const [day, count] of turnDays) {
    const dayMap = grouped.get(day)!;
    const existing = dayMap.get(key);
    const breakdown = existing ?? {
      provider: 'xai', product: 'grok-build', channel: 'cli', model,
      project: fields.project, projectDisplay: fields.projectDisplay, projectAlias: fields.projectAlias,
      eventCount: 0, sessionCount: 0, inputTokens: 0, cachedInputTokens: 0,
      cacheWriteTokens: 0, outputTokens: 0, reasoningOutputTokens: 0,
    } satisfies IngestBreakdown;
    breakdown.sessionCount = (breakdown.sessionCount ?? 0) + 1;
    breakdown.eventCount += count;
    dayMap.set(key, breakdown);

    // Session-level usage has no per-turn attribution; count it only once.
    if (day !== tokenDate) continue;
    const usage = authoritativeUsage(records);
    if (usage) {
      breakdown.inputTokens += usage.input;
      breakdown.outputTokens += usage.output;
      breakdown.cachedInputTokens += usage.cached;
      breakdown.reasoningOutputTokens += usage.reasoning;
    } else {
      // contextTokensUsed / _meta.totalTokens are context occupancy, not billed splits.
      const estimate = estimateTokens(records);
      breakdown.inputTokens += estimate.input;
      breakdown.outputTokens += estimate.output;
      breakdown.reasoningOutputTokens += estimate.reasoning;
      breakdown.cachedInputTokens += estimate.cached;
    }
  }
}

function authoritativeUsage(records: Array<{ file: string; record: Json }>): TokenEstimate | null {
  let input = 0;
  let output = 0;
  let cached = 0;
  let reasoning = 0;
  let found = false;
  for (const { record } of records) {
    walk(record, (obj) => {
      const inValue = numberField(obj, [
        'inputTokens', 'input_tokens', 'inputTokenCount', 'input_token_count',
        'totalInputTokens', 'total_input_tokens', 'promptTokens', 'prompt_tokens',
      ]);
      const outValue = numberField(obj, [
        'outputTokens', 'output_tokens', 'outputTokenCount', 'output_token_count',
        'totalOutputTokens', 'total_output_tokens', 'completionTokens', 'completion_tokens',
      ]);
      const cachedValue = numberField(obj, [
        'cachedInputTokens', 'cached_input_tokens', 'cacheReadTokens', 'cache_read_tokens',
        'cachedTokens', 'cached_tokens',
      ]);
      const reasoningValue = numberField(obj, [
        'reasoningTokens', 'reasoning_tokens', 'reasoningOutputTokens', 'reasoning_output_tokens',
        'thoughtTokens', 'thought_tokens',
      ]);
      // Only paired billable usage counts; never treat totalTokens / contextTokensUsed as usage.
      if (inValue !== undefined || outValue !== undefined) {
        input += inValue ?? 0;
        output += outValue ?? 0;
        cached += cachedValue ?? 0;
        reasoning += reasoningValue ?? 0;
        found = true;
      }
    });
  }
  return found ? { input, output, cached, reasoning } : null;
}

/**
 * Heuristic token estimate.
 *
 * Primary source: chat_history.jsonl
 *   - system / user / tool_result → input
 *   - assistant content + tool_calls → output
 * Supplemental (not in chat_history):
 *   - updates agent_thought_chunk → reasoning
 *
 * When chat_history is empty, fall back entirely to updates chunks
 * (including tool_call rawInput as output).
 */
function estimateTokens(records: Array<{ file: string; record: Json }>): TokenEstimate {
  const fromChat = estimateFromChatHistory(records);
  if (fromChat.input > 0 || fromChat.output > 0) {
    // Thoughts live in updates streaming log, not chat_history.
    const reasoning = estimateThoughtTokens(records);
    return { ...fromChat, reasoning, cached: 0 };
  }
  return estimateFromUpdates(records);
}

function estimateFromChatHistory(records: Array<{ file: string; record: Json }>): TokenEstimate {
  const seen = new Set<string>();
  let input = 0;
  let output = 0;

  for (const { file, record } of records) {
    if (file !== 'chat_history.jsonl') continue;

    const role = messageRole(record);
    if (!role) continue;

    const text = textField(record) ?? '';
    const toolText = role === 'assistant' ? toolCallsText(record) : '';
    if (!text && !toolText) continue;

    const id = String(
      record.id
      ?? record.message_id
      ?? record.messageId
      ?? `${role}:${hashText(text)}:${hashText(toolText)}`,
    );
    if (seen.has(id)) continue;
    seen.add(id);

    if (role === 'assistant') {
      output += approxTokens(text) + approxTokens(toolText);
    } else {
      // system | user | tool_result → next-turn input
      input += approxTokens(text);
    }
  }

  return { input, output, reasoning: 0, cached: 0 };
}

function estimateThoughtTokens(records: Array<{ file: string; record: Json }>): number {
  const seen = new Set<string>();
  let reasoning = 0;
  for (const { file, record } of records) {
    if (file !== 'updates.jsonl') continue;
    const update = nestedUpdate(record);
    if (!update) continue;
    if (String(update.sessionUpdate ?? '') !== 'agent_thought_chunk') continue;
    const text = textField(update) ?? textField(record);
    if (!text) continue;
    const meta = updateMeta(record, update);
    const dedupeKey = String(meta?.eventId ?? `thought:${hashText(text)}`);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    reasoning += approxTokens(text);
  }
  return reasoning;
}

function estimateFromUpdates(records: Array<{ file: string; record: Json }>): TokenEstimate {
  const seen = new Set<string>();
  let input = 0;
  let output = 0;
  let reasoning = 0;

  for (const { file, record } of records) {
    if (file !== 'updates.jsonl') continue;
    const update = nestedUpdate(record);
    if (!update) continue;
    const sessionUpdate = String(update.sessionUpdate ?? '');
    const meta = updateMeta(record, update);

    if (sessionUpdate === 'user_message_chunk') {
      const text = textField(update) ?? textField(record);
      if (!text) continue;
      const key = String(meta?.eventId ?? `in:${hashText(text)}`);
      if (seen.has(key)) continue;
      seen.add(key);
      input += approxTokens(text);
      continue;
    }

    if (sessionUpdate === 'agent_message_chunk') {
      const text = textField(update) ?? textField(record);
      if (!text) continue;
      const key = String(meta?.eventId ?? `out:${hashText(text)}`);
      if (seen.has(key)) continue;
      seen.add(key);
      output += approxTokens(text);
      continue;
    }

    if (sessionUpdate === 'agent_thought_chunk') {
      const text = textField(update) ?? textField(record);
      if (!text) continue;
      const key = String(meta?.eventId ?? `thought:${hashText(text)}`);
      if (seen.has(key)) continue;
      seen.add(key);
      reasoning += approxTokens(text);
      continue;
    }

    // tool_call carries model-generated args (rawInput) — bill as output.
    if (sessionUpdate === 'tool_call') {
      const toolCallId = String(update.toolCallId ?? update.tool_call_id ?? '');
      const key = toolCallId ? `tc:${toolCallId}` : `tc:${hashText(stableStringify(update.rawInput ?? update))}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const name = String(update.title ?? update.name ?? '');
      const argsText = stringifyUnknown(update.rawInput ?? update.input ?? update.arguments);
      output += approxTokens(name) + approxTokens(argsText);
    }
  }

  return { input, output, reasoning, cached: 0 };
}

function toolCallsText(obj: Json): string {
  const calls = obj.tool_calls ?? obj.toolCalls;
  if (!Array.isArray(calls) || calls.length === 0) return '';
  const parts: string[] = [];
  for (const raw of calls) {
    if (!raw || typeof raw !== 'object') continue;
    const call = raw as Json;
    if (typeof call.name === 'string' && call.name) parts.push(call.name);
    if (typeof call.arguments === 'string' && call.arguments) parts.push(call.arguments);
    else if (call.arguments != null) parts.push(stringifyUnknown(call.arguments));
    else if (typeof call.input === 'string' && call.input) parts.push(call.input);
    else if (call.input != null) parts.push(stringifyUnknown(call.input));
  }
  return parts.join('\n');
}

function stringifyUnknown(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function stableStringify(value: unknown): string {
  return stringifyUnknown(value);
}

function nestedUpdate(record: Json): Json | null {
  const params = record.params;
  if (!params || typeof params !== 'object') return null;
  const update = (params as Json).update;
  if (!update || typeof update !== 'object') return null;
  return update as Json;
}

function updateMeta(record: Json, update: Json): Json | undefined {
  const params = record.params && typeof record.params === 'object' ? record.params as Json : undefined;
  const fromParams = params?._meta;
  if (fromParams && typeof fromParams === 'object') return fromParams as Json;
  const fromUpdate = update._meta;
  if (fromUpdate && typeof fromUpdate === 'object') return fromUpdate as Json;
  return undefined;
}

function messageRole(obj: Json): 'user' | 'assistant' | 'system' | 'tool' | null {
  // Real Grok chat_history uses `type` as the role discriminator (no `role` field).
  const raw = String(obj.role ?? obj.author ?? obj.sender ?? obj.type ?? '').toLowerCase();
  if (!raw || raw === 'text' || raw === 'image' || raw === 'tool_use' || raw === 'function') return null;
  if (raw === 'backend_tool_call' || raw === 'tool_call') return null;
  if (raw === 'assistant' || raw === 'model' || raw === 'bot') return 'assistant';
  if (raw === 'system' || raw === 'developer') return 'system';
  if (raw === 'user' || raw === 'human') return 'user';
  if (raw === 'tool' || raw === 'tool_result' || raw === 'function_result') return 'tool';
  return null;
}

function textField(obj: Json): string | undefined {
  for (const key of ['text', 'content', 'message']) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value;
    if (Array.isArray(value)) {
      const parts: string[] = [];
      for (const item of value) {
        if (typeof item === 'string' && item.trim()) {
          parts.push(item);
          continue;
        }
        if (item && typeof item === 'object') {
          const block = item as Json;
          if (typeof block.text === 'string' && block.text.trim()) parts.push(block.text);
          else if (typeof block.content === 'string' && block.content.trim()) parts.push(block.content);
        }
      }
      if (parts.length > 0) return parts.join('\n');
    }
    // Nested content object: { type: 'text', text: '...' }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = value as Json;
      if (typeof nested.text === 'string' && nested.text.trim()) return nested.text;
    }
  }
  return undefined;
}

function approxTokens(text: string): number {
  if (!text) return 0;
  // Approximation only; no Grok tokenizer is shipped. Unicode-aware via code points.
  return Math.ceil([...text].length / 4);
}

function hashText(text: string): string {
  // Short stable key for dedupe (not cryptographic).
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  return `${text.length}:${h}`;
}

function eventType(obj: Json): string | undefined {
  return findString(obj, ['type', 'event_type', 'eventType']);
}

/** Prefer top-level date fields (events use `ts`; summary uses created_at / updated_at). */
function recordDate(obj: Json): string | undefined {
  const top = recordDateTopLevel(obj);
  if (top) return top;
  const raw = findString(obj, ['ts', 'timestamp', 'created_at', 'createdAt', 'started_at', 'startedAt', 'updated_at', 'updatedAt', 'last_active_at']);
  const date = parseTs(raw);
  return date ? dateKey(date) : undefined;
}

function recordDateTopLevel(obj: Json): string | undefined {
  for (const key of ['ts', 'timestamp', 'created_at', 'createdAt', 'started_at', 'startedAt', 'updated_at', 'updatedAt', 'last_active_at']) {
    const value = obj[key];
    if (typeof value === 'string' || typeof value === 'number') {
      const date = parseTs(value);
      if (date) return dateKey(date);
    }
  }
  return undefined;
}

function findString(obj: Json, keys: string[]): string | undefined {
  let value: string | undefined;
  walk(obj, (candidate) => {
    if (value) return;
    for (const key of keys) {
      if (typeof candidate[key] === 'string') {
        value = candidate[key] as string;
        break;
      }
    }
  });
  return value;
}

function numberField(obj: Json, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function walk(value: unknown, visit: (obj: Json) => void): void {
  if (Array.isArray(value)) {
    value.forEach(v => walk(v, visit));
    return;
  }
  if (!value || typeof value !== 'object') return;
  const obj = value as Json;
  visit(obj);
  Object.values(obj).forEach(v => walk(v, visit));
}

function decodeCwd(value: string): string {
  try { return decodeURIComponent(value); } catch { return basename(value) || 'unknown'; }
}

async function safeRead(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8'); } catch { return undefined; }
}
