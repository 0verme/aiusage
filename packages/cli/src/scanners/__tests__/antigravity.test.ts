import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanAntigravityDates, parseGeneration } from '../antigravity.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'aiusage-antigravity-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────
// 最小 protobuf wire encoder：fixture 用真实 wire bytes，避免依赖仓库外的 .proto
// ─────────────────────────────────────────────────────────────

/** -1 的 two's complement 10 字节 varint 编码，用于验证哨兵值不被当成 token。 */
const NEGATIVE_ONE_VARINT = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]);

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let current = value;
  do {
    const byte = current % 128;
    current = Math.floor(current / 128);
    bytes.push(current > 0 ? byte | 0x80 : byte);
  } while (current > 0);
  return Buffer.from(bytes);
}

function tag(field: number, wire: number): Buffer {
  return encodeVarint(field * 8 + wire);
}

function bytesField(field: number, payload: Buffer): Buffer {
  return Buffer.concat([tag(field, 2), encodeVarint(payload.length), payload]);
}

function messageField(field: number, parts: Buffer[]): Buffer {
  return bytesField(field, Buffer.concat(parts));
}

function varintField(field: number, value: number): Buffer {
  return Buffer.concat([tag(field, 0), encodeVarint(value)]);
}

function textField(field: number, value: string): Buffer {
  return bytesField(field, Buffer.from(value, 'utf8'));
}

interface UsageOptions {
  systemPrompt?: number;
  freshInput?: number;
  cacheRead?: number;
  output?: number;
  thinking?: number;
  responseId?: string;
  /** 追加的未知 / 派生字段（field 3、6、7…）。 */
  extra?: Buffer[];
}

/** ChatModel.usage（field 4）。 */
function usageMessage(options: UsageOptions = {}): Buffer {
  const parts: Buffer[] = [];
  if (options.systemPrompt !== undefined) parts.push(varintField(1, options.systemPrompt));
  if (options.freshInput !== undefined) parts.push(varintField(2, options.freshInput));
  if (options.cacheRead !== undefined) parts.push(varintField(5, options.cacheRead));
  if (options.output !== undefined) parts.push(varintField(9, options.output));
  if (options.thinking !== undefined) parts.push(varintField(10, options.thinking));
  if (options.responseId !== undefined) parts.push(textField(11, options.responseId));
  parts.push(...options.extra ?? []);
  return Buffer.concat(parts);
}

interface ChatModelOptions {
  /** ChatModel.model = 原始 model id。 */
  model?: string;
  usage?: Buffer;
  labels?: Array<[string, string]>;
  extra?: Buffer[];
}

function chatModelMessage(options: ChatModelOptions): Buffer {
  const parts: Buffer[] = [];
  if (options.model !== undefined) parts.push(textField(19, options.model));
  if (options.usage !== undefined) parts.push(messageField(4, [options.usage]));
  for (const [key, value] of options.labels ?? []) {
    parts.push(messageField(20, [textField(1, key), textField(2, value)]));
  }
  parts.push(...options.extra ?? []);
  return Buffer.concat(parts);
}

/** GeneratorMetadata：field 1 = chatModel。 */
function generatorMetadata(chatModel: Buffer, extra: Buffer[] = []): Buffer {
  return Buffer.concat([messageField(1, [chatModel]), ...extra]);
}

/** TrajectoryMetadata：field 2 = {1: seconds, 2: nanos}，field 1 = workspace。 */
function trajectoryMetadata(options: { createdAtMs?: number; workspaceUri?: string } = {}): Buffer {
  const parts: Buffer[] = [];
  if (options.workspaceUri) {
    parts.push(messageField(1, [textField(1, options.workspaceUri), textField(2, options.workspaceUri)]));
  }
  if (options.createdAtMs !== undefined) {
    const seconds = Math.floor(options.createdAtMs / 1000);
    const nanos = (options.createdAtMs % 1000) * 1_000_000;
    parts.push(messageField(2, [varintField(1, seconds), varintField(2, nanos)]));
  }
  return Buffer.concat(parts);
}

// ─────────────────────────────────────────────────────────────
// 最小 SQLite fixture
// ─────────────────────────────────────────────────────────────

const GEN_SCHEMA = 'CREATE TABLE `gen_metadata` (`idx` INTEGER PRIMARY KEY, `data` BLOB, `size` INTEGER NOT NULL DEFAULT 0)';
const TRAJECTORY_SCHEMA = 'CREATE TABLE `trajectory_metadata_blob` (`id` TEXT DEFAULT "main", `data` BLOB, PRIMARY KEY (`id`))';

interface FixtureOptions {
  /** gen_metadata.data 原始 BLOB，按顺序写入 idx。 */
  generations?: Buffer[];
  /** trajectory_metadata_blob 的 data；省略则不建该表。 */
  trajectory?: Buffer;
  /** 省略 gen_metadata 表，模拟非 Antigravity DB。 */
  withoutGenTable?: boolean;
  /** 显式指定文件 mtime，用于验证时间归属不是来自 mtime。 */
  mtime?: Date;
}

async function writeFixtureDb(dbPath: string, options: FixtureOptions = {}): Promise<void> {
  const db = new DatabaseSync(dbPath);
  try {
    if (!options.withoutGenTable) {
      db.exec(GEN_SCHEMA);
      const insert = db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)');
      (options.generations ?? []).forEach((blob, index) => insert.run(index, blob, blob.length));
    }
    if (options.trajectory) {
      db.exec(TRAJECTORY_SCHEMA);
      db.prepare('INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)').run('main', options.trajectory);
    }
  } finally {
    db.close();
  }
  if (options.mtime) await utimes(dbPath, options.mtime, options.mtime);
}

function conversationDbPath(baseDir: string, sessionId: string): string {
  return join(baseDir, 'conversations', `${sessionId}.db`);
}

async function writeConversationDb(
  baseDir: string,
  sessionId: string,
  options: FixtureOptions = {},
): Promise<string> {
  const dbPath = conversationDbPath(baseDir, sessionId);
  await mkdir(join(baseDir, 'conversations'), { recursive: true });
  await writeFixtureDb(dbPath, options);
  return dbPath;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
}

/** 与 `dateKey` 相同的本地日期口径，供测试表达“本地 usage date”。 */
function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const CREATED_AT_MS = Date.UTC(2026, 1, 10, 12, 0, 0);

function simpleGeneration(options: {
  model?: string;
  systemPrompt?: number;
  freshInput?: number;
  cacheRead?: number;
  output?: number;
  thinking?: number;
  responseId?: string;
} = {}): Buffer {
  return generatorMetadata(chatModelMessage({
    model: options.model ?? 'gemini-3.8-flash',
    usage: usageMessage({
      systemPrompt: options.systemPrompt ?? 1318,
      freshInput: options.freshInput ?? 2000,
      ...options.cacheRead !== undefined ? { cacheRead: options.cacheRead } : {},
      output: options.output ?? 300,
      thinking: options.thinking ?? 50,
      ...options.responseId !== undefined ? { responseId: options.responseId } : {},
    }),
  }));
}

// ─────────────────────────────────────────────────────────────
// 正常解析
// ─────────────────────────────────────────────────────────────

describe('scanAntigravityDates token parsing', () => {
  it('maps generation-level tokens, model and project from gen_metadata', async () => {
    const baseDir = join(tmpDir, 'antigravity');
    await writeConversationDb(baseDir, 'session-a', {
      trajectory: trajectoryMetadata({
        createdAtMs: CREATED_AT_MS,
        workspaceUri: 'file:///C:/work/demo-project',
      }),
      generations: [
        simpleGeneration({ freshInput: 2000, cacheRead: 18000, output: 300, thinking: 50, responseId: 'resp-1' }),
      ],
    });

    const usageDate = localDateKey(new Date(CREATED_AT_MS));
    const result = await scanAntigravityDates([usageDate], baseDir);

    expect(result.get(usageDate)).toEqual([
      {
        provider: 'google',
        product: 'antigravity',
        channel: 'ide',
        model: 'gemini-3.8-flash',
        project: 'C:/work/demo-project',
        projectDisplay: 'demo-project',
        projectAlias: undefined,
        eventCount: 1,
        sessionCount: 1,
        // system-prompt(1318) + fresh(2000)
        inputTokens: 3318,
        cachedInputTokens: 18000,
        cacheWriteTokens: 0,
        outputTokens: 300,
        reasoningOutputTokens: 50,
      },
    ]);
  });

  it('aggregates multiple generations of one session into a single breakdown', async () => {
    const baseDir = join(tmpDir, 'antigravity');
    await writeConversationDb(baseDir, 'session-a', {
      trajectory: trajectoryMetadata({ createdAtMs: CREATED_AT_MS }),
      generations: [
        simpleGeneration({ freshInput: 1000, output: 10, thinking: 5, responseId: 'resp-1' }),
        simpleGeneration({ freshInput: 1000, output: 20, thinking: 5, responseId: 'resp-2' }),
        simpleGeneration({ freshInput: 1000, output: 30, thinking: 5, responseId: 'resp-3' }),
      ],
    });

    const usageDate = localDateKey(new Date(CREATED_AT_MS));
    const [breakdown] = (await scanAntigravityDates([usageDate], baseDir)).get(usageDate) ?? [];

    expect(breakdown.eventCount).toBe(3);
    expect(breakdown.sessionCount).toBe(1);
    expect(breakdown.inputTokens).toBe(1318 * 3 + 3000);
    expect(breakdown.outputTokens).toBe(60);
    expect(breakdown.reasoningOutputTokens).toBe(15);
    // 没有 cache-write 指标，恒为 0
    expect(breakdown.cacheWriteTokens).toBe(0);
  });

  it('falls back to the label placeholder when the raw model id is absent', async () => {
    const baseDir = join(tmpDir, 'antigravity');
    await writeConversationDb(baseDir, 'session-a', {
      trajectory: trajectoryMetadata({ createdAtMs: CREATED_AT_MS }),
      generations: [
        generatorMetadata(chatModelMessage({
          usage: usageMessage({ systemPrompt: 1318, freshInput: 10, output: 1, responseId: 'resp-1' }),
          labels: [['model_enum', 'MODEL_PLACEHOLDER_M318']],
        })),
      ],
    });

    const usageDate = localDateKey(new Date(CREATED_AT_MS));
    const [breakdown] = (await scanAntigravityDates([usageDate], baseDir)).get(usageDate) ?? [];
    // 保留数据源原始值，不猜测真实模型
    expect(breakdown.model).toBe('MODEL_PLACEHOLDER_M318');
  });

  it('keeps unknown as the model when neither model id nor placeholder exists', async () => {
    const baseDir = join(tmpDir, 'antigravity');
    await writeConversationDb(baseDir, 'session-a', {
      trajectory: trajectoryMetadata({ createdAtMs: CREATED_AT_MS }),
      generations: [
        generatorMetadata(chatModelMessage({
          usage: usageMessage({ systemPrompt: 1318, freshInput: 10, output: 1, responseId: 'resp-1' }),
        })),
      ],
    });

    const usageDate = localDateKey(new Date(CREATED_AT_MS));
    const [breakdown] = (await scanAntigravityDates([usageDate], baseDir)).get(usageDate) ?? [];
    expect(breakdown.model).toBe('unknown');
  });

  it('decodes a percent-encoded workspace URI into a project', async () => {
    const baseDir = join(tmpDir, 'antigravity');
    await writeConversationDb(baseDir, 'session-a', {
      trajectory: trajectoryMetadata({
        createdAtMs: CREATED_AT_MS,
        workspaceUri: 'file:///C:/work/My%20Projects/example-repo',
      }),
      generations: [simpleGeneration({ responseId: 'resp-1' })],
    });

    const usageDate = localDateKey(new Date(CREATED_AT_MS));
    const [breakdown] = (await scanAntigravityDates([usageDate], baseDir)).get(usageDate) ?? [];
    expect(breakdown.project).toBe('C:/work/My Projects/example-repo');
    expect(breakdown.projectDisplay).toBe('example-repo');
  });

  it('uses unknown when the session exposes no workspace', async () => {
    const baseDir = join(tmpDir, 'antigravity');
    await writeConversationDb(baseDir, 'session-a', {
      trajectory: trajectoryMetadata({ createdAtMs: CREATED_AT_MS }),
      generations: [simpleGeneration({ responseId: 'resp-1' })],
    });

    const usageDate = localDateKey(new Date(CREATED_AT_MS));
    const [breakdown] = (await scanAntigravityDates([usageDate], baseDir)).get(usageDate) ?? [];
    expect(breakdown.project).toBe('unknown');
  });
});

// ─────────────────────────────────────────────────────────────
// 多模型 / 多个 session
// ─────────────────────────────────────────────────────────────

describe('scanAntigravityDates breakdown splitting', () => {
  it('splits one session into separate breakdowns per model', async () => {
    const baseDir = join(tmpDir, 'antigravity');
    await writeConversationDb(baseDir, 'session-a', {
      trajectory: trajectoryMetadata({ createdAtMs: CREATED_AT_MS }),
      generations: [
        simpleGeneration({ model: 'gemini-3.8-flash', freshInput: 100, output: 10, responseId: 'resp-1' }),
        simpleGeneration({ model: 'claude-sonnet-4-6', freshInput: 200, output: 20, responseId: 'resp-2' }),
        simpleGeneration({ model: 'gemini-3.8-flash', freshInput: 300, output: 30, responseId: 'resp-3' }),
      ],
    });

    const usageDate = localDateKey(new Date(CREATED_AT_MS));
    const breakdowns = (await scanAntigravityDates([usageDate], baseDir)).get(usageDate) ?? [];
    const byModel = new Map(breakdowns.map(b => [b.model, b]));

    expect(breakdowns).toHaveLength(2);
    expect(byModel.get('gemini-3.8-flash')?.eventCount).toBe(2);
    expect(byModel.get('gemini-3.8-flash')?.inputTokens).toBe(1318 * 2 + 400);
    expect(byModel.get('claude-sonnet-4-6')?.eventCount).toBe(1);
    expect(byModel.get('claude-sonnet-4-6')?.cachedInputTokens).toBe(0);
  });

  it('counts distinct sessions per breakdown', async () => {
    const baseDir = join(tmpDir, 'antigravity');
    for (const sessionId of ['session-a', 'session-b']) {
      await writeConversationDb(baseDir, sessionId, {
        trajectory: trajectoryMetadata({ createdAtMs: CREATED_AT_MS }),
        generations: [simpleGeneration({ responseId: `resp-${sessionId}` })],
      });
    }

    const usageDate = localDateKey(new Date(CREATED_AT_MS));
    const [breakdown] = (await scanAntigravityDates([usageDate], baseDir)).get(usageDate) ?? [];
    expect(breakdown.eventCount).toBe(2);
    expect(breakdown.sessionCount).toBe(2);
  });

  it('splits one day into separate breakdowns per project', async () => {
    const baseDir = join(tmpDir, 'antigravity');
    await writeConversationDb(baseDir, 'session-a', {
      trajectory: trajectoryMetadata({ createdAtMs: CREATED_AT_MS, workspaceUri: 'file:///C:/work/alpha' }),
      generations: [simpleGeneration({ responseId: 'resp-1' })],
    });
    await writeConversationDb(baseDir, 'session-b', {
      trajectory: trajectoryMetadata({ createdAtMs: CREATED_AT_MS, workspaceUri: 'file:///C:/work/beta' }),
      generations: [simpleGeneration({ responseId: 'resp-2' })],
    });

    const usageDate = localDateKey(new Date(CREATED_AT_MS));
    const breakdowns = (await scanAntigravityDates([usageDate], baseDir)).get(usageDate) ?? [];
    expect(breakdowns.map(b => b.projectDisplay).sort()).toEqual(['alpha', 'beta']);
  });
});

// ─────────────────────────────────────────────────────────────
// 时间归属
// ─────────────────────────────────────────────────────────────

describe('scanAntigravityDates usage date attribution', () => {
  it('attributes generations to the local date of the session timestamp, not the DB mtime', async () => {
    const baseDir = join(tmpDir, 'antigravity');
    const mtime = new Date(Date.UTC(2026, 1, 13, 6, 0, 0));
    await writeConversationDb(baseDir, 'session-a', {
      trajectory: trajectoryMetadata({ createdAtMs: CREATED_AT_MS }),
      generations: [simpleGeneration({ responseId: 'resp-1' })],
      mtime,
    });

    const result = await scanAntigravityDates(
      ['2026-02-09', '2026-02-10', '2026-02-11', '2026-02-12', '2026-02-13'],
      baseDir,
    );
    const populated = [...result.entries()].filter(([, breakdowns]) => breakdowns.length > 0);

    // 本地日期口径（与 dateKey 一致），与 UTC 日期、DB mtime 都不同时也不会串档
    expect(populated).toHaveLength(1);
    expect(populated[0][0]).toBe(localDateKey(new Date(CREATED_AT_MS)));
    expect(populated[0][1][0].eventCount).toBe(1);
  });

  it('falls back to the DB mtime when the session timestamp is missing or invalid', async () => {
    const baseDir = join(tmpDir, 'antigravity');
    const mtime = new Date(Date.UTC(2026, 1, 12, 3, 0, 0));
    await writeConversationDb(baseDir, 'session-a', {
      // 没有 field 2：无法从 protobuf 得到创建时间
      trajectory: trajectoryMetadata({ workspaceUri: 'file:///C:/work/alpha' }),
      generations: [simpleGeneration({ responseId: 'resp-1' })],
      mtime,
    });

    const usageDate = localDateKey(mtime);
    const [breakdown] = (await scanAntigravityDates([usageDate], baseDir)).get(usageDate) ?? [];
    expect(breakdown.eventCount).toBe(1);
    expect(breakdown.inputTokens).toBe(3318);
  });

  it('falls back to the DB mtime when the session timestamp is untrustworthy', async () => {
    const baseDir = join(tmpDir, 'antigravity');
    const mtime = new Date(Date.UTC(2026, 1, 12, 3, 0, 0));
    // nanos = 2_000_000_000 超出 0..999_999_999，视为不可信
    const badTimestamp = messageField(2, [
      varintField(1, Math.floor(CREATED_AT_MS / 1000)),
      varintField(2, 2_000_000_000),
    ]);
    await writeConversationDb(baseDir, 'session-a', {
      trajectory: badTimestamp,
      generations: [simpleGeneration({ responseId: 'resp-1' })],
      mtime,
    });

    const usageDate = localDateKey(mtime);
    const [breakdown] = (await scanAntigravityDates([usageDate], baseDir)).get(usageDate) ?? [];
    expect(breakdown.eventCount).toBe(1);
  });

  it('drops generations whose date is outside the requested range', async () => {
    const baseDir = join(tmpDir, 'antigravity');
    await writeConversationDb(baseDir, 'session-a', {
      trajectory: trajectoryMetadata({ createdAtMs: CREATED_AT_MS }),
      generations: [simpleGeneration({ responseId: 'resp-1' })],
    });

    const result = await scanAntigravityDates(['2026-02-09'], baseDir);
    expect(result.get('2026-02-09')).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// 去重
// ─────────────────────────────────────────────────────────────

describe('scanAntigravityDates deduplication', () => {
  it('counts a responseId shared by two databases only once', async () => {
    const baseDir = join(tmpDir, 'antigravity');
    const generation = simpleGeneration({ freshInput: 5000, output: 100, responseId: 'shared-response' });
    await writeConversationDb(baseDir, 'session-a', {
      trajectory: trajectoryMetadata({ createdAtMs: CREATED_AT_MS }),
      generations: [generation],
    });
    // backup / 迁移副本：同一 responseId 出现在另一个 DB
    await writeConversationDb(baseDir, 'session-a-copy', {
      trajectory: trajectoryMetadata({ createdAtMs: CREATED_AT_MS }),
      generations: [generation],
    });

    const usageDate = localDateKey(new Date(CREATED_AT_MS));
    const breakdowns = (await scanAntigravityDates([usageDate], baseDir)).get(usageDate) ?? [];
    expect(breakdowns).toHaveLength(1);
    expect(breakdowns[0].eventCount).toBe(1);
    expect(breakdowns[0].inputTokens).toBe(1318 + 5000);
  });

  it('deduplicates repeated responseIds inside one database', async () => {
    const baseDir = join(tmpDir, 'antigravity');
    await writeConversationDb(baseDir, 'session-a', {
      trajectory: trajectoryMetadata({ createdAtMs: CREATED_AT_MS }),
      generations: [
        simpleGeneration({ responseId: 'same' }),
        simpleGeneration({ responseId: 'same' }),
      ],
    });

    const usageDate = localDateKey(new Date(CREATED_AT_MS));
    const [breakdown] = (await scanAntigravityDates([usageDate], baseDir)).get(usageDate) ?? [];
    expect(breakdown.eventCount).toBe(1);
  });

  it('keeps generations without a responseId, deduplicating them by row identity', async () => {
    const baseDir = join(tmpDir, 'antigravity');
    await writeConversationDb(baseDir, 'session-a', {
      trajectory: trajectoryMetadata({ createdAtMs: CREATED_AT_MS }),
      generations: [
        simpleGeneration({ freshInput: 10, responseId: undefined }),
        simpleGeneration({ freshInput: 20, responseId: undefined }),
      ],
    });

    const usageDate = localDateKey(new Date(CREATED_AT_MS));
    const [breakdown] = (await scanAntigravityDates([usageDate], baseDir)).get(usageDate) ?? [];
    expect(breakdown.eventCount).toBe(2);
    expect(breakdown.inputTokens).toBe(1318 * 2 + 30);
  });
});

// ─────────────────────────────────────────────────────────────
// protobuf 边界：malformed / unknown field / 缺失字段
// ─────────────────────────────────────────────────────────────

describe('parseGeneration protobuf handling', () => {
  it('parses the documented field map into tokens', () => {
    const parsed = parseGeneration(simpleGeneration({
      systemPrompt: 1318,
      freshInput: 2000,
      cacheRead: 18000,
      output: 300,
      thinking: 50,
      responseId: 'resp-1',
    }));

    expect(parsed).toEqual({
      responseId: 'resp-1',
      model: 'gemini-3.8-flash',
      tokens: { input: 3318, cached: 18000, cacheWrite: 0, output: 300, reasoning: 50 },
    });
  });

  it('ignores the derived output total (field 3) and the unidentified field 6', () => {
    const parsed = parseGeneration(generatorMetadata(chatModelMessage({
      model: 'gemini-3.8-flash',
      usage: usageMessage({
        systemPrompt: 1318,
        freshInput: 10,
        output: 300,
        thinking: 50,
        // field 3 恒等于 output + thinking，field 6 语义未确认：都不能计入
        extra: [varintField(3, 350), varintField(6, 24)],
        responseId: 'resp-1',
      }),
    })));

    expect(parsed?.tokens).toEqual({ input: 1328, cached: 0, cacheWrite: 0, output: 300, reasoning: 50 });
  });

  it('skips system-prompt-only stub rows', () => {
    const parsed = parseGeneration(generatorMetadata(chatModelMessage({
      model: 'gemini-3.8-flash',
      usage: usageMessage({ systemPrompt: 1318 }),
    })));

    expect(parsed).toBeNull();
  });

  it('does not treat a negative sentinel varint as a token count', () => {
    const usage = Buffer.concat([varintField(1, 1318), tag(2, 0), NEGATIVE_ONE_VARINT]);
    const parsed = parseGeneration(generatorMetadata(chatModelMessage({ model: 'gemini-3.8-flash', usage })));
    // field 2 = -1 不是可信的 token 计数 → 没有真实信号 → 跳过
    expect(parsed).toBeNull();
  });

  it('skips the oversized context snapshot stored in field 1', () => {
    const snapshot = generatorMetadata(Buffer.alloc(256 * 1024, 0x41));
    expect(parseGeneration(snapshot)).toBeNull();
  });

  it('returns null for malformed blobs instead of throwing', () => {
    const malformed = [
      Buffer.from([]),
      Buffer.from([0x0a]),                                  // 截断的 tag
      Buffer.from([0x0a, 0x05, 0x01]),                      // length 越界
      Buffer.from([0x0a, 0xff, 0xff, 0xff, 0xff, 0xff]),    // 截断的 varint
      Buffer.from([0x0b, 0x00]),                            // group wire type
      Buffer.from([0x07, 0x00]),                            // field 0（非法字段号）
      Buffer.from([0x0d, 0x01, 0x02]),                      // fixed32 越界
    ];
    for (const blob of malformed) {
      expect(parseGeneration(blob)).toBeNull();
    }
  });

  it('keeps parsing known fields when unknown fields are present', () => {
    const parsed = parseGeneration(generatorMetadata(
      chatModelMessage({
        model: 'gemini-3.8-flash',
        usage: usageMessage({ systemPrompt: 1318, freshInput: 10, output: 1, responseId: 'resp-1' }),
        // 未知字段：varint / 字符串 / 嵌套消息 / fixed64 / fixed32
        extra: [
          varintField(30, 7),
          textField(31, 'schema-drift'),
          messageField(32, [varintField(1, 99)]),
          Buffer.concat([tag(33, 1), Buffer.alloc(8, 0x01)]),
          Buffer.concat([tag(34, 5), Buffer.alloc(4, 0x02)]),
        ],
      }),
      [varintField(2, 12), textField(9, 'future-field')],
    ));

    expect(parsed?.model).toBe('gemini-3.8-flash');
    expect(parsed?.responseId).toBe('resp-1');
    expect(parsed?.tokens).toEqual({ input: 1328, cached: 0, cacheWrite: 0, output: 1, reasoning: 0 });
  });

  it('handles missing usage / model / responseId / timestamp fields', () => {
    // 没有 usage
    expect(parseGeneration(generatorMetadata(chatModelMessage({ model: 'gemini-3.8-flash' })))).toBeNull();
    // usage 不是合法 message
    const brokenUsage = messageField(4, [Buffer.from([0x0a, 0x05, 0x01])]);
    expect(parseGeneration(generatorMetadata(Buffer.concat([brokenUsage])))).toBeNull();

    // 缺 model / responseId / thinking，但 token 有效
    const parsed = parseGeneration(generatorMetadata(chatModelMessage({
      usage: usageMessage({ systemPrompt: 1318, freshInput: 42, output: 3 }),
    })));
    expect(parsed).toEqual({
      responseId: undefined,
      model: 'unknown',
      tokens: { input: 1360, cached: 0, cacheWrite: 0, output: 3, reasoning: 0 },
    });
  });
});

// ─────────────────────────────────────────────────────────────
// 异常与兼容性
// ─────────────────────────────────────────────────────────────

describe('scanAntigravityDates resilience', () => {
  it('returns empty results when Antigravity is not installed', async () => {
    const result = await scanAntigravityDates(['2026-02-10'], join(tmpDir, 'missing'));
    expect(result.get('2026-02-10')).toEqual([]);
  });

  it('ignores corrupted databases and keeps scanning the healthy ones', async () => {
    const baseDir = join(tmpDir, 'antigravity');
    await mkdir(join(baseDir, 'conversations'), { recursive: true });
    await writeFile(join(baseDir, 'conversations', 'broken.db'), 'not a sqlite database');
    await writeConversationDb(baseDir, 'session-a', {
      trajectory: trajectoryMetadata({ createdAtMs: CREATED_AT_MS }),
      generations: [simpleGeneration({ responseId: 'resp-1' })],
    });

    const usageDate = localDateKey(new Date(CREATED_AT_MS));
    const [breakdown] = (await scanAntigravityDates([usageDate], baseDir)).get(usageDate) ?? [];
    expect(breakdown.eventCount).toBe(1);
    expect(breakdown.inputTokens).toBe(3318);
  });

  it('ignores databases without a gen_metadata table and empty gen_metadata', async () => {
    const baseDir = join(tmpDir, 'antigravity');
    await writeConversationDb(baseDir, 'session-a', { withoutGenTable: true, trajectory: trajectoryMetadata({ createdAtMs: CREATED_AT_MS }) });
    await writeConversationDb(baseDir, 'session-b', { generations: [], trajectory: trajectoryMetadata({ createdAtMs: CREATED_AT_MS }) });

    const usageDate = localDateKey(new Date(CREATED_AT_MS));
    expect((await scanAntigravityDates([usageDate], baseDir)).get(usageDate)).toEqual([]);
  });

  it('skips individual malformed generations without dropping the session', async () => {
    const baseDir = join(tmpDir, 'antigravity');
    await writeConversationDb(baseDir, 'session-a', {
      trajectory: trajectoryMetadata({ createdAtMs: CREATED_AT_MS }),
      generations: [
        simpleGeneration({ freshInput: 10, responseId: 'resp-1' }),
        Buffer.from([0x0a, 0x05, 0x01]),
        generatorMetadata(Buffer.alloc(200 * 1024, 0x41)),
        simpleGeneration({ freshInput: 20, responseId: 'resp-2' }),
      ],
    });

    const usageDate = localDateKey(new Date(CREATED_AT_MS));
    const [breakdown] = (await scanAntigravityDates([usageDate], baseDir)).get(usageDate) ?? [];
    expect(breakdown.eventCount).toBe(2);
    expect(breakdown.inputTokens).toBe(1318 * 2 + 30);
  });

  it('ignores .db-wal / .db-shm sidecars and unrelated files', async () => {
    const baseDir = join(tmpDir, 'antigravity');
    await writeConversationDb(baseDir, 'session-a', {
      trajectory: trajectoryMetadata({ createdAtMs: CREATED_AT_MS }),
      generations: [simpleGeneration({ responseId: 'resp-1' })],
    });
    await writeFile(conversationDbPath(baseDir, 'session-a') + '-wal', '');
    await writeFile(conversationDbPath(baseDir, 'session-a') + '-shm', '');
    await writeFile(join(baseDir, 'conversations', 'notes.txt'), 'ignored');

    const usageDate = localDateKey(new Date(CREATED_AT_MS));
    const [breakdown] = (await scanAntigravityDates([usageDate], baseDir)).get(usageDate) ?? [];
    expect(breakdown.eventCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────
// 旧 activity 兼容
// ─────────────────────────────────────────────────────────────

describe('scanAntigravityDates legacy activity fallback', () => {
  it('reports one session event and deduplicates brain/browser metadata for the same session id', async () => {
    const baseDir = join(tmpDir, 'antigravity');
    // 三个时间戳都在同一天（任何时区下），确保 local date 稳定
    await writeJson(
      join(baseDir, 'brain', 'session-a', 'task.md.metadata.json'),
      { artifactType: 'ARTIFACT_TYPE_TASK', updatedAt: '2026-02-10T15:55:04.375550Z' },
    );
    await writeJson(
      join(baseDir, 'browser_recordings', 'session-a', 'metadata.json'),
      { highlights: [{ start_time: '2026-02-10T16:00:38.549354Z', end_time: '2026-02-10T16:00:40.594582Z' }] },
    );
    await writeJson(
      join(baseDir, 'browser_recordings', 'session-b', 'metadata.json'),
      { highlights: [{ start_time: '2026-02-10T15:00:00.000Z', end_time: '2026-02-10T15:00:05.000Z' }] },
    );

    const usageDate = localDateKey(new Date('2026-02-10T15:55:04.375Z'));
    const result = await scanAntigravityDates([usageDate], baseDir);

    expect(result.get(usageDate)).toEqual([
      {
        provider: 'google',
        product: 'antigravity',
        channel: 'ide',
        model: 'unknown',
        project: 'unknown',
        eventCount: 2,
        sessionCount: 2,
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
    ]);
  });

  it('does not double count a session that already produced real generations', async () => {
    const baseDir = join(tmpDir, 'antigravity');
    await writeConversationDb(baseDir, 'session-a', {
      trajectory: trajectoryMetadata({ createdAtMs: CREATED_AT_MS }),
      generations: [simpleGeneration({ freshInput: 10, responseId: 'resp-1' })],
    });
    await writeJson(
      join(baseDir, 'brain', 'session-a', 'task.md.metadata.json'),
      { artifactType: 'ARTIFACT_TYPE_TASK', updatedAt: new Date(CREATED_AT_MS).toISOString() },
    );

    const usageDate = localDateKey(new Date(CREATED_AT_MS));
    const breakdowns = (await scanAntigravityDates([usageDate], baseDir)).get(usageDate) ?? [];

    expect(breakdowns).toHaveLength(1);
    expect(breakdowns[0].eventCount).toBe(1);
    expect(breakdowns[0].model).toBe('gemini-3.8-flash');
  });

  it('still reports legacy activity for a session whose database has no generations', async () => {
    const baseDir = join(tmpDir, 'antigravity');
    await writeConversationDb(baseDir, 'session-a', { generations: [] });
    await writeJson(
      join(baseDir, 'brain', 'session-a', 'task.md.metadata.json'),
      { artifactType: 'ARTIFACT_TYPE_TASK', updatedAt: new Date(CREATED_AT_MS).toISOString() },
    );

    const usageDate = localDateKey(new Date(CREATED_AT_MS));
    const breakdowns = (await scanAntigravityDates([usageDate], baseDir)).get(usageDate) ?? [];
    expect(breakdowns).toHaveLength(1);
    expect(breakdowns[0].model).toBe('unknown');
    expect(breakdowns[0].eventCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────
// SQLite 只读保证
// ─────────────────────────────────────────────────────────────

describe('scanAntigravityDates read-only guarantee', () => {
  it('never writes to the user database', async () => {
    const baseDir = join(tmpDir, 'antigravity');
    const dbPath = await writeConversationDb(baseDir, 'session-a', {
      trajectory: trajectoryMetadata({ createdAtMs: CREATED_AT_MS, workspaceUri: 'file:///C:/work/alpha' }),
      generations: [simpleGeneration({ freshInput: 10, responseId: 'resp-1' })],
    });

    const before = createHash('sha256').update(await readFile(dbPath)).digest('hex');
    const beforeStat = await stat(dbPath);

    await scanAntigravityDates([localDateKey(new Date(CREATED_AT_MS))], baseDir);

    const after = createHash('sha256').update(await readFile(dbPath)).digest('hex');
    const afterStat = await stat(dbPath);
    expect(after).toBe(before);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    expect(afterStat.size).toBe(beforeStat.size);
  });
});
