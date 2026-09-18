import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import type { IngestBreakdown } from '@aiusage/shared';
import {
  parseTs,
  dateKey,
  fileModifiedTs,
  initDateMap,
  accumulate,
  finalize,
  emptyResult,
  resolveProjectFields,
  scannerModelFields,
} from './utils.js';
import { runSqliteQuery, sqliteBlob, sqliteHasTable, type SqliteRow } from './sqlite.js';
import {
  allBytes,
  decodeProtoMessage,
  firstBytes,
  readText,
  safeVarint,
  type ProtoMessage,
} from './protobuf.js';

/**
 * Antigravity scanner。
 *
 * 真实 usage 只存在于 SQLite conversation DB：
 *
 *   ~/.gemini/antigravity/conversations/<session-uuid>.db → gen_metadata.data
 *
 * 每一行 `data` 是一条 generation 级 protobuf，包含原始 model id、input /
 * cache-read / output / thinking token，以及跨 DB 稳定的 responseId。
 *
 * `brain/**` 下的 transcript 只有 created_at / step_index 与文本内容，没有任何
 * token / usage / model 字段，因此这里不做任何基于文本长度的估算：拿不到真实
 * token 的 session 只会退回旧的 session/activity 计数（token 保持 0），不会伪造用量。
 *
 * 数据库全程以只读方式打开。
 */

const CONVERSATIONS_DIR = 'conversations';
const GEN_TABLE = 'gen_metadata';
const TRAJECTORY_BLOB_TABLE = 'trajectory_metadata_blob';

/**
 * 实测 chatModel 消息只有约 600 字节；个别记录的 field 1 是 200KB+ 的上下文快照
 * （prompt 正文），不是 chatModel。用尺寸上限把这类记录挡在解码之外。
 */
const MAX_CHAT_MODEL_BYTES = 64 * 1024;

/**
 * `parseTs` 会把小于 1e12 的数值当成秒级时间戳。这里自己算出的毫秒值若小于该阈值
 * 就会在 parseTs 内被二次乘 1000，因此先自行设下界（2001-09-09）。
 */
const MIN_EPOCH_MS = 1e12;

// ── protobuf 字段号（本机 Antigravity，SQLite user_version = 1 实测）──

/** GeneratorMetadata.chatModel */
const GEN_CHAT_MODEL = 1;

/** ChatModel.usage */
const CHAT_USAGE = 4;
/** ChatModel.model（原始 model id 字符串） */
const CHAT_MODEL_ID = 19;
/** ChatModel.labels（map<string,string>） */
const CHAT_LABELS = 20;

/**
 * Usage 数值字段。
 *
 * 注意两个刻意不映射的字段：
 * - field 3 恒等于 field 9 + field 10（output + thinking，1832/1832 验证通过），
 *   是派生总量而不是独立分类，相加会重复计数。
 * - field 6 实测恒为 24，语义未确认，不做猜测。
 */
const USAGE_SYSTEM_PROMPT_INPUT = 1;
const USAGE_FRESH_INPUT = 2;
const USAGE_CACHE_READ_INPUT = 5;
const USAGE_OUTPUT = 9;
const USAGE_THINKING_OUTPUT = 10;
const USAGE_RESPONSE_ID = 11;

/** ChatModel.labels 中记录面列名的键。 */
const LABEL_MODEL_ENUM = 'model_enum';
const LABEL_KEY = 1;
const LABEL_VALUE = 2;

/** TrajectoryMetadata。 */
const TRAJ_WORKSPACE = 1;
const TRAJ_CREATED_AT = 2;
const TRAJ_WORKSPACE_URI = 7;
/** workspace 消息里的 workspace URI（第 1、2 项通常相同）。 */
const WORKSPACE_PATH = 1;
const WORKSPACE_REMOTE = 2;

interface AntigravityTokens {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}

interface ParsedGeneration {
  /** protobuf 中稳定且跨 DB 唯一的 responseId，用于去重；缺失时退回 session + 行号。 */
  responseId?: string;
  model: string;
  tokens: AntigravityTokens;
}

interface RowGeneration extends ParsedGeneration {
  /** `gen_metadata.idx`，仅用于 responseId 缺失时的兜底去重身份。 */
  rowIndex: string;
}

interface AntigravitySessionInfo {
  /**
   * session 创建时间。当前版本 protobuf 里没有 generation 级 wall-clock 时间戳，
   * 因此整个 session 的 generation 都按 session 创建时间归属 usage date。
   */
  createdAt: Date | null;
  workspace: string;
}

interface AntigravityBrowserMetadata {
  highlights?: Array<{
    start_time?: string;
    end_time?: string;
  }>;
}

interface AntigravityArtifactMetadata {
  updatedAt?: string;
}

export async function scanAntigravityDates(
  targetDates: string[],
  baseDir?: string,
): Promise<Map<string, IngestBreakdown[]>> {
  const dates = new Set(targetDates);
  const dir = baseDir ?? join(homedir(), '.gemini', 'antigravity');
  const grouped = initDateMap(dates);
  const sessionsByBreakdown = new Map<string, Set<string>>();
  /** 已经处理过的 generation 身份，避免同一 responseId 被多个 DB 重复统计。 */
  const seenIdentities = new Set<string>();
  /** 已经产出真实 usage 的 session，不再计入旧 activity 计数。 */
  const sessionsWithUsage = new Set<string>();

  for (const dbPath of await listConversationDatabases(join(dir, CONVERSATIONS_DIR))) {
    const sessionId = basename(dbPath, '.db');
    const generations = await readGenerations(dbPath);
    if (generations.length === 0) continue;

    // DB 里已经有真实 usage：这个 session 不再走旧 activity 路径，避免同一个 session
    // 同时被算成 generation 和 activity。
    sessionsWithUsage.add(sessionId);

    const session = await readSessionInfo(dbPath);
    const timestamp = session.createdAt ?? await fileModifiedTs(dbPath);
    if (!timestamp) continue;

    const usageDate = dateKey(timestamp);
    const dayMap = grouped.get(usageDate);
    if (!dayMap) continue;

    const projectFields = session.workspace === 'unknown'
      ? { project: 'unknown', projectDisplay: 'unknown', projectAlias: undefined }
      : resolveProjectFields(session.workspace);

    for (const generation of generations) {
      const identity = generation.responseId
        ? `response:${generation.responseId}`
        : `row:${sessionId}#${generation.rowIndex}`;
      if (seenIdentities.has(identity)) continue;
      seenIdentities.add(identity);

      const modelFields = scannerModelFields(generation.model);
      const breakdownKey = `${modelFields.model}|${projectFields.project}`;

      accumulate(
        dayMap,
        breakdownKey,
        {
          provider: 'google',
          product: 'antigravity',
          channel: 'ide',
          ...modelFields,
          project: projectFields.project,
          projectDisplay: projectFields.projectDisplay,
          projectAlias: projectFields.projectAlias,
          inputTokens: 0,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        },
        generation.tokens,
      );

      addSession(sessionsByBreakdown, usageDate, breakdownKey, sessionId);
    }
  }

  await collectLegacyActivity(dir, grouped, sessionsByBreakdown, sessionsWithUsage);
  applySessionCounts(grouped, sessionsByBreakdown);

  return finalize(grouped);
}

/**
 * 日期发现：遍历 conversations/*.db，读取每个 session 的创建日期。
 * antigravity 的 usage 归属 session createdAt，brain/browser 的 JSON 布局
 * 随 Antigravity 版本变化，不能作为唯一日期来源。
 */
export async function discoverAntigravityDbDates(baseDir?: string): Promise<Set<string>> {
  const dir = baseDir ?? join(homedir(), '.gemini', 'antigravity');
  const dates = new Set<string>();

  for (const dbPath of await listConversationDatabases(join(dir, CONVERSATIONS_DIR))) {
    const session = await readSessionInfo(dbPath);
    const timestamp = session.createdAt ?? await fileModifiedTs(dbPath);
    if (timestamp) dates.add(dateKey(timestamp));
  }

  return dates;
}

async function listConversationDatabases(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.db'))
    .map(entry => join(dir, entry.name))
    .sort();
}

async function readGenerations(dbPath: string): Promise<RowGeneration[]> {
  // 没有 gen_metadata 表的 DB 不是 Antigravity conversation DB。
  if (!await sqliteHasTable(dbPath, GEN_TABLE)) return [];

  let rows: SqliteRow[];
  try {
    rows = await runSqliteQuery(dbPath, `SELECT idx, data FROM ${GEN_TABLE} ORDER BY idx`);
  } catch {
    // 单个 DB 损坏时跳过，其他 DB 继续扫描。
    return [];
  }

  const generations: RowGeneration[] = [];
  rows.forEach((row, index) => {
    const blob = sqliteBlob(row.data);
    if (!blob) return;
    // 单条 generation 解码失败只跳过这一条。
    const parsed = parseGeneration(blob);
    if (!parsed) return;
    generations.push({ ...parsed, rowIndex: String(row.idx ?? index) });
  });
  return generations;
}

/**
 * 从一条 `GeneratorMetadata` 中取 model 与 token。
 * 拿不到可信 token 时返回 `null`（跳过），绝不给出估算值。
 */
export function parseGeneration(blob: Buffer): ParsedGeneration | null {
  const outer = decodeProtoMessage(blob);
  if (!outer) return null;

  const chatBytes = firstBytes(outer, GEN_CHAT_MODEL);
  if (!chatBytes || chatBytes.length === 0 || chatBytes.length > MAX_CHAT_MODEL_BYTES) return null;

  const chat = decodeProtoMessage(chatBytes);
  if (!chat) return null;

  const usageBytes = firstBytes(chat, CHAT_USAGE);
  if (!usageBytes) return null;
  const usage = decodeProtoMessage(usageBytes);
  if (!usage) return null;

  const systemPrompt = safeVarint(usage, USAGE_SYSTEM_PROMPT_INPUT) ?? 0;
  const freshInput = safeVarint(usage, USAGE_FRESH_INPUT) ?? 0;
  const cacheRead = safeVarint(usage, USAGE_CACHE_READ_INPUT) ?? 0;
  const output = safeVarint(usage, USAGE_OUTPUT) ?? 0;
  const thinking = safeVarint(usage, USAGE_THINKING_OUTPUT) ?? 0;

  // 只有固定 system-prompt 扣费、没有任何真实信号的记录是空 generation 存根
  // （本机上同时缺 responseId）。既不算 usage，也不算 event。
  if (freshInput + cacheRead + output + thinking === 0) return null;

  return {
    responseId: readText(usage, USAGE_RESPONSE_ID),
    model: parseModel(chat),
    tokens: {
      // system-prompt 扣费是每次生成真实计入的 input，但不能和 cache-read 相加。
      input: systemPrompt + freshInput,
      cached: cacheRead,
      // Antigravity 没有 cache-write 指标。
      cacheWrite: 0,
      output,
      reasoning: thinking,
    },
  };
}

function parseModel(chat: ProtoMessage): string {
  const direct = readText(chat, CHAT_MODEL_ID);
  if (direct) return direct;

  // 少数记录只在 labels 里留下匿名占位符（如 MODEL_PLACEHOLDER_M318）。保留原始值，
  // 不做 alias 猜测：模型规范化与定价统一交给 shared/pricing。
  for (const label of allBytes(chat, CHAT_LABELS)) {
    const entry = decodeProtoMessage(label);
    if (!entry) continue;
    if (readText(entry, LABEL_KEY) !== LABEL_MODEL_ENUM) continue;
    const value = readText(entry, LABEL_VALUE);
    if (value) return value;
  }

  return 'unknown';
}

async function readSessionInfo(dbPath: string): Promise<AntigravitySessionInfo> {
  const fallback: AntigravitySessionInfo = { createdAt: null, workspace: 'unknown' };

  let rows: SqliteRow[];
  try {
    rows = await runSqliteQuery(dbPath, `SELECT data FROM ${TRAJECTORY_BLOB_TABLE} LIMIT 1`);
  } catch {
    return fallback;
  }
  if (rows.length === 0) return fallback;

  const blob = sqliteBlob(rows[0].data);
  if (!blob) return fallback;

  const message = decodeProtoMessage(blob);
  if (!message) return fallback;

  return {
    createdAt: parseProtoTimestamp(firstBytes(message, TRAJ_CREATED_AT)),
    workspace: parseWorkspace(message) ?? 'unknown',
  };
}

/** `{1: seconds, 2: nanos}` → Date（UTC）。 */
function parseProtoTimestamp(bytes?: Buffer): Date | null {
  if (!bytes) return null;

  const message = decodeProtoMessage(bytes);
  if (!message) return null;

  const seconds = safeVarint(message, 1);
  const nanos = safeVarint(message, 2) ?? 0;
  if (seconds === undefined || nanos > 999_999_999) return null;

  const ms = seconds * 1000 + Math.floor(nanos / 1e6);
  if (!Number.isFinite(ms) || ms < MIN_EPOCH_MS) return null;

  return parseTs(ms);
}

function parseWorkspace(message: ProtoMessage): string | undefined {
  const nested = firstBytes(message, TRAJ_WORKSPACE);
  if (nested) {
    const workspace = decodeProtoMessage(nested);
    if (workspace) {
      const uri = readText(workspace, WORKSPACE_PATH) ?? readText(workspace, WORKSPACE_REMOTE);
      const decoded = decodeFileUri(uri);
      if (decoded) return decoded;
    }
  }

  return decodeFileUri(readText(message, TRAJ_WORKSPACE_URI));
}

function decodeFileUri(raw?: string): string | undefined {
  if (!raw) return undefined;
  const stripped = raw.replace(/^file:\/\//, '');
  if (!stripped) return undefined;

  let decoded: string;
  try {
    decoded = decodeURIComponent(stripped);
  } catch {
    decoded = stripped;
  }

  // `file:///C:/work` 的盘符路径本身不包含前导斜杠；POSIX 路径的前导斜杠是路径的一部分。
  return /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded;
}

/**
 * 旧 activity 兜底：`brain/<session>` 与 `browser_recordings/<session>` 的 metadata
 * 只提供 session 级信息，没有 token 字段。仅对“没有解析出任何真实 generation”的
 * session 生效，因此同一个 session 不会被重复计算 event。
 */
async function collectLegacyActivity(
  dir: string,
  grouped: ReturnType<typeof initDateMap>,
  sessionsByBreakdown: Map<string, Set<string>>,
  sessionsWithUsage: Set<string>,
): Promise<void> {
  const sessionDates = new Map<string, Date>();
  await collectBrainSessionDates(join(dir, 'brain'), sessionDates);
  await collectBrowserSessionDates(join(dir, 'browser_recordings'), sessionDates);

  const modelFields = scannerModelFields(undefined);

  for (const [sessionId, timestamp] of sessionDates) {
    if (sessionsWithUsage.has(sessionId)) continue;

    const usageDate = dateKey(timestamp);
    const dayMap = grouped.get(usageDate);
    if (!dayMap) continue;

    const breakdownKey = `${modelFields.model}|unknown`;
    accumulate(
      dayMap,
      breakdownKey,
      {
        provider: 'google',
        product: 'antigravity',
        channel: 'ide',
        ...modelFields,
        project: 'unknown',
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
      { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 },
    );

    addSession(sessionsByBreakdown, usageDate, breakdownKey, sessionId);
  }
}

async function collectBrainSessionDates(dir: string, sessionDates: Map<string, Date>): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const taskMetadata = await readJson<AntigravityArtifactMetadata>(join(dir, entry.name, 'task.md.metadata.json'));
    const timestamp = parseTs(taskMetadata?.updatedAt);
    if (!timestamp) continue;

    upsertSessionDate(sessionDates, entry.name, timestamp);
  }
}

async function collectBrowserSessionDates(dir: string, sessionDates: Map<string, Date>): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const metadata = await readJson<AntigravityBrowserMetadata>(join(dir, entry.name, 'metadata.json'));
    const timestamp = parseTs(metadata?.highlights?.[0]?.start_time ?? metadata?.highlights?.[0]?.end_time);
    if (!timestamp) continue;

    upsertSessionDate(sessionDates, entry.name, timestamp);
  }
}

function addSession(
  sessionsByBreakdown: Map<string, Set<string>>,
  usageDate: string,
  breakdownKey: string,
  sessionId: string,
): void {
  const key = `${usageDate}\0${breakdownKey}`;
  const sessions = sessionsByBreakdown.get(key) ?? new Set<string>();
  sessions.add(sessionId);
  sessionsByBreakdown.set(key, sessions);
}

function applySessionCounts(
  grouped: ReturnType<typeof initDateMap>,
  sessionsByBreakdown: Map<string, Set<string>>,
): void {
  for (const [key, sessions] of sessionsByBreakdown) {
    const separator = key.indexOf('\0');
    const breakdown = grouped.get(key.slice(0, separator))?.get(key.slice(separator + 1));
    if (breakdown) breakdown.sessionCount = sessions.size;
  }
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function upsertSessionDate(sessionDates: Map<string, Date>, sessionId: string, timestamp: Date): void {
  const existing = sessionDates.get(sessionId);
  if (!existing || timestamp < existing) {
    sessionDates.set(sessionId, timestamp);
  }
}
