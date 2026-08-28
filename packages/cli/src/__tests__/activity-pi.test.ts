import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ActivityReport } from '../activity.js';

async function writeJsonl(path: string, lines: object[]): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, lines.map(line => JSON.stringify(line)).join('\n'));
}

let tmpDir: string;
let sessionFile: string;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `aiusage-activity-pi-${Date.now()}`);
  sessionFile = join(tmpDir, 'pi', '--E--AI生成代码-aiusage--', '2026-06-24T12-00-00-000Z_pi-s1.jsonl');
  await mkdir(join(sessionFile, '..'), { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function build(dates: string[]): Promise<ActivityReport> {
  const { buildActivityReport } = await import('../activity.js');
  return buildActivityReport('all', {
    dates,
    codexDir: join(tmpDir, 'missing-codex'),
    claudeProjectsDirs: [join(tmpDir, 'missing-claude')],
    piDir: join(tmpDir, 'pi'),
  });
}

/** 复刻真实 Pi Session JSONL 核心结构（参照 ~/.pi/agent/sessions 实测 schema）。 */
function piSessionHeader(cwd: string): object {
  return { type: 'session', version: 2, id: 'pi-s1', timestamp: '2026-06-24T12:00:00.000Z', cwd };
}

function piUser(id: string, timestamp: string, text: string): object {
  return {
    type: 'message',
    id,
    timestamp,
    message: { role: 'user', provider: 'openai-codex', model: 'gpt-5.6-luna', content: [{ type: 'text', text }] },
  };
}

function piToolResult(id: string, timestamp: string, toolCallId: string, toolName: string, text: string): object {
  return {
    type: 'message',
    id,
    timestamp,
    message: {
      role: 'toolResult',
      toolCallId,
      toolName,
      timestamp,
      content: [{ type: 'text', text }],
    },
  };
}

function piAssistant(id: string, timestamp: string, content: object[]): object {
  return {
    type: 'message',
    id,
    timestamp,
    message: { role: 'assistant', provider: 'openai-codex', model: 'gpt-5.6-luna', content },
  };
}

function toolCall(id: string, name: string, args: Record<string, unknown>): object {
  return { type: 'toolCall', id, name, arguments: args };
}

describe('Pi activity scanning', () => {
  it('counts Pi user messages with exact confidence without leaking message body', async () => {
    await writeJsonl(sessionFile, [
      piSessionHeader('E:\\AI生成代码\\aiusage'),
      piUser('m-1', '2026-06-24T12:00:10.000Z', '帮我看一下 interaction 指标'),
      piUser('m-2', '2026-06-24T12:01:00.000Z', '再帮我查一下成本'),
    ]);

    const report = await build(['2026-06-24']);

    expect(report.totals.userMessageCount).toBe(2);
    expect(report.bySource.find(row => row.key === 'openai-codex/pi')?.count).toBe(2);
    const userItem = report.items.find(item => item.kind === 'user_message');
    expect(userItem?.provider).toBe('openai-codex');
    expect(userItem?.product).toBe('pi');
    expect(userItem?.confidence).toBe('exact');
    // 隐私：消息正文不得进入任何字段
    expect(JSON.stringify(report.items)).not.toContain('interaction 指标');
    expect(JSON.stringify(report.items)).not.toContain('再帮我查一下成本');
  });

  it('maps a single Pi toolCall to tool_call exact (never function_call)', async () => {
    await writeJsonl(sessionFile, [
      piSessionHeader('E:\\AI生成代码\\aiusage'),
      piAssistant('a-1', '2026-06-24T12:01:00.000Z', [toolCall('tc-1', 'bash', { command: 'pnpm test', timeout: 60 })]),
    ]);

    const report = await build(['2026-06-24']);

    expect(report.totals.exactCount).toBe(1);
    expect(report.byKind.find(row => row.key === 'tool_call')?.count).toBe(1);
    expect(report.byKind.find(row => row.key === 'function_call')?.count).toBeUndefined();
    expect(report.byKind.find(row => row.key === 'function_call')?.count ?? 0).toBe(0);
    const item = report.items[0];
    expect(item.kind).toBe('tool_call');
    expect(item.name).toBe('bash');
    expect(item.confidence).toBe('exact');
  });

  it('counts multiple toolCalls in one assistant message and toolResults are ignored', async () => {
    await writeJsonl(sessionFile, [
      piSessionHeader('E:\\AI生成代码\\aiusage'),
      piAssistant('a-1', '2026-06-24T12:01:00.000Z', [
        toolCall('tc-1', 'read', { path: 'E:\\AI生成代码\\aiusage\\src\\activity.ts', limit: 10 }),
        toolCall('tc-2', 'bash', { command: 'git status' }),
        toolCall('tc-3', 'edit', { path: 'E:\\AI生成代码\\aiusage\\src\\activity.ts' }),
      ]),
      piToolResult('tr-1', '2026-06-24T12:01:10.000Z', 'tc-1', 'read', 'file content'),
    ]);

    const report = await build(['2026-06-24']);

    expect(report.totals.exactCount).toBe(3);
    expect(report.topTools.length).toBe(3);
    expect(report.topTools.map(row => row.label)).toContain('read (openai-codex/pi)');
    expect(report.topTools.map(row => row.label)).toContain('bash (openai-codex/pi)');
    expect(report.topTools.map(row => row.label)).toContain('edit (openai-codex/pi)');
  });

  it('dedupes toolCalls with the same toolCall id', async () => {
    await writeJsonl(sessionFile, [
      piSessionHeader('E:\\AI生成代码\\aiusage'),
      piAssistant('a-1', '2026-06-24T12:01:00.000Z', [toolCall('tc-1', 'bash', { command: 'pnpm test' })]),
      piAssistant('a-2', '2026-06-24T12:01:05.000Z', [toolCall('tc-1', 'bash', { command: 'pnpm test' })]),
    ]);

    const report = await build(['2026-06-24']);

    expect(report.totals.exactCount).toBe(1);
    expect(report.byKind.find(row => row.key === 'tool_call')?.count).toBe(1);
  });

  it('skips malformed JSON and lines without message', async () => {
    const lines = [
      JSON.stringify(piSessionHeader('E:\\AI生成代码\\aiusage')),
      '{ this is not valid json',
      JSON.stringify({ type: 'message', id: 'no-msg-1' }),
      JSON.stringify({ type: 'custom', customType: 'plan-mode-state', data: {} }),
      JSON.stringify(piAssistant('a-1', '2026-06-24T12:01:00.000Z', [toolCall('tc-1', 'bash', { command: 'ls' })])),
    ];
    await mkdir(join(sessionFile, '..'), { recursive: true });
    await writeFile(sessionFile, lines.join('\n'));

    const report = await build(['2026-06-24']);

    expect(report.totals.exactCount).toBe(1);
    expect(report.totals.filesScanned).toBe(1);
  });

  it('ignores non-assistant and non-user messages (toolResult role)', async () => {
    await writeJsonl(sessionFile, [
      piSessionHeader('E:\\AI生成代码\\aiusage'),
      piToolResult('tr-1', '2026-06-24T12:01:00.000Z', 'tc-1', 'bash', 'done'),
      { type: 'message', id: 'm-x', timestamp: '2026-06-24T12:02:00.000Z', message: { role: 'system', content: [] } },
    ]);

    const report = await build(['2026-06-24']);

    expect(report.totals.exactCount).toBe(0);
    expect(report.totals.userMessageCount).toBe(0);
  });

  it('recognizes SKILL.md paths in read/bash arguments as skill_proxy with bare skill name', async () => {
    await writeJsonl(sessionFile, [
      piSessionHeader('E:\\AI生成代码\\aiusage'),
      piAssistant('a-1', '2026-06-24T12:01:00.000Z', [
        toolCall('tc-1', 'read', { path: 'C:\\Users\\me\\.pi\\agent\\skills\\commit-message-writer\\SKILL.md', limit: 10 }),
      ]),
      piAssistant('a-2', '2026-06-24T12:02:00.000Z', [
        toolCall('tc-2', 'bash', { command: 'type C:\\Users\\me\\.pi\\agent\\skills\\pi-lens-ast-grep\\SKILL.md' }),
      ]),
    ]);

    const report = await build(['2026-06-24']);

    expect(report.totals.proxyCount).toBe(2);
    const skillRows = report.topSkills.filter(row => row.proxyCount > 0);
    expect(skillRows.map(row => row.label)).toContain('commit-message-writer (proxy)');
    expect(skillRows.map(row => row.label)).toContain('pi-lens-ast-grep (proxy)');
    // 隐私：不得暴露本地完整路径
    expect(JSON.stringify(report.items)).not.toContain('SKILL.md');
    expect(JSON.stringify(report.items)).not.toContain('C:\\Users\\me');
  });

  it('does not treat arbitrary md/readme paths as skills', async () => {
    await writeJsonl(sessionFile, [
      piSessionHeader('E:\\AI生成代码\\aiusage'),
      piAssistant('a-1', '2026-06-24T12:01:00.000Z', [
        toolCall('tc-1', 'read', { path: 'E:\\AI生成代码\\aiusage\\README.md' }),
        toolCall('tc-2', 'read', { path: 'E:\\AI生成代码\\aiusage\\docs\\pricing.md' }),
        toolCall('tc-3', 'read', { path: 'C:\\Users\\me\\notes\\draft\\notes.md' }),
      ]),
    ]);

    const report = await build(['2026-06-24']);

    expect(report.totals.proxyCount).toBe(0);
    expect(report.topSkills).toHaveLength(0);
    // 但工具调用本身仍然计数（3 个 read）
    expect(report.totals.exactCount).toBe(3);
    expect(report.byKind.find(row => row.key === 'tool_call')?.count).toBe(3);
  });

  it('detects explicit /skill:<name> user message as skill_call exact', async () => {
    await writeJsonl(sessionFile, [
      piSessionHeader('E:\\AI生成代码\\aiusage'),
      piUser('m-1', '2026-06-24T12:00:10.000Z', '/skill:security-review\n请检查这个仓库'),
    ]);

    const report = await build(['2026-06-24']);

    expect(report.byKind.find(row => row.key === 'skill_call')?.count).toBe(1);
    const item = report.items.find(row => row.kind === 'skill_call');
    expect(item?.name).toBe('security-review');
    expect(item?.confidence).toBe('exact');
    // 隐私：不泄漏 /skill 指令正文
    expect(JSON.stringify(report.items)).not.toContain('请检查这个仓库');
  });

  it('counts structured subagent toolCall as agent_call with agent name', async () => {
    await writeJsonl(sessionFile, [
      piSessionHeader('E:\\AI生成代码\\aiusage'),
      piAssistant('a-1', '2026-06-24T12:01:00.000Z', [
        toolCall('tc-1', 'subagent', { agent: 'code-reviewer', task: 'audit the diff' }),
      ]),
    ]);

    const report = await build(['2026-06-24']);

    expect(report.byKind.find(row => row.key === 'agent_call')?.count).toBe(1);
    const item = report.items.find(row => row.kind === 'agent_call');
    expect(item?.name).toBe('code-reviewer');
    expect(item?.confidence).toBe('exact');
    // 隐私：subagent 任务描述不得上传
    expect(JSON.stringify(report.items)).not.toContain('audit the diff');
  });

  it('falls back to subagent when agent name is missing or prompt-like', async () => {
    await writeJsonl(sessionFile, [
      piSessionHeader('E:\\AI生成代码\\aiusage'),
      piAssistant('a-1', '2026-06-24T12:01:00.000Z', [
        toolCall('tc-1', 'subagent', { task: 'please review everything carefully' }),
      ]),
    ]);

    const report = await build(['2026-06-24']);

    expect(report.byKind.find(row => row.key === 'agent_call')?.count).toBe(1);
    expect(report.items.find(row => row.kind === 'agent_call')?.name).toBe('subagent');
    expect(JSON.stringify(report.items)).not.toContain('please review everything');
  });

  it('does not guess subagents from unrelated tool names', async () => {
    await writeJsonl(sessionFile, [
      piSessionHeader('E:\\AI生成代码\\aiusage'),
      piAssistant('a-1', '2026-06-24T12:01:00.000Z', [
        toolCall('tc-1', 'bash', { command: 'spawn worker' }),
        toolCall('tc-2', 'todo', { action: 'create', subject: 'run task' }),
        toolCall('tc-3', 'write', { path: 'E:\\x\\task.md', content: 'subagent notes' }),
      ]),
    ]);

    const report = await build(['2026-06-24']);

    expect(report.byKind.find(row => row.key === 'agent_call')?.count ?? 0).toBe(0);
    expect(report.totals.exactCount).toBe(3);
  });

  it('filters by target date', async () => {
    await writeJsonl(sessionFile, [
      piSessionHeader('E:\\AI生成代码\\aiusage'),
      piUser('m-1', '2026-06-24T12:00:10.000Z', '今天的事'),
      piAssistant('a-1', '2026-06-24T12:01:00.000Z', [toolCall('tc-1', 'read', { path: 'E:\\x\\a.ts' })]),
      piAssistant('a-2', '2026-06-25T12:01:00.000Z', [toolCall('tc-2', 'bash', { command: 'ls' })]),
    ]);

    const report = await build(['2026-06-24']);

    expect(report.totals.userMessageCount).toBe(1);
    expect(report.totals.exactCount).toBe(1);
    expect(report.items.every(item => item.usageDate === '2026-06-24')).toBe(true);
  });

  it('resolves project fields from session header cwd with alias', async () => {
    await writeJsonl(sessionFile, [
      piSessionHeader('E:\\AI生成代码\\aiusage'),
      piAssistant('a-1', '2026-06-24T12:01:00.000Z', [toolCall('tc-1', 'bash', { command: 'ls' })]),
    ]);

    const { buildActivityReport } = await import('../activity.js');
    const report = await buildActivityReport('all', {
      dates: ['2026-06-24'],
      codexDir: join(tmpDir, 'missing-codex'),
      claudeProjectsDirs: [join(tmpDir, 'missing-claude')],
      piDir: join(tmpDir, 'pi'),
      projectAliases: { 'E:\\AI生成代码\\aiusage': 'aiusage-alias' },
    });

    expect(report.items[0].project).toBe('E:\\AI生成代码\\aiusage');
    expect(report.items[0].projectAlias).toBe('aiusage-alias');
  });

  it('merges Codex + Claude + Pi into one unified report', async () => {
    const codexSession = join(tmpDir, 'codex', 'sessions', '2026', '06', '24', 'mix-codex.jsonl');
    await writeJsonl(codexSession, [
      { type: 'session_meta', timestamp: '2026-06-24T12:00:00.000Z', payload: { id: 'codex-mix' } },
      {
        type: 'response_item',
        timestamp: '2026-06-24T12:01:00.000Z',
        payload: { item: { type: 'function_call', name: 'exec_command', call_id: 'c-1', arguments: '{}' } },
      },
    ]);
    const claudeProjects = join(tmpDir, 'claude', 'projects');
    const claudeSession = join(claudeProjects, '-Users-test-AIUsage', 'mix-claude.jsonl');
    await writeJsonl(claudeSession, [
      {
        type: 'assistant',
        timestamp: '2026-06-24T12:00:00.000Z',
        sessionId: 'claude-mix',
        cwd: '/Users/test/AIUsage',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't-1', name: 'Bash', input: { command: 'ls' } }],
        },
      },
    ]);
    await writeJsonl(sessionFile, [
      piSessionHeader('E:\\AI生成代码\\aiusage'),
      piUser('m-1', '2026-06-24T12:00:10.000Z', '混合验证'),
      piAssistant('a-1', '2026-06-24T12:01:00.000Z', [toolCall('tc-1', 'read', { path: 'E:\\x\\a.ts' })]),
    ]);

    const { buildActivityReport } = await import('../activity.js');
    const report = await buildActivityReport('all', {
      dates: ['2026-06-24'],
      codexDir: join(tmpDir, 'codex'),
      claudeProjectsDirs: [claudeProjects],
      piDir: join(tmpDir, 'pi'),
    });

    expect(report.bySource.map(row => row.key).sort()).toEqual([
      'anthropic/claude-code',
      'openai-codex/pi',
      'openai/codex',
    ]);
    expect(report.totals.userMessageCount).toBe(1);
    expect(report.totals.sessionsScanned).toBe(3);
  });

  it('includes Pi in topTools and topAgents rankings', async () => {
    await writeJsonl(sessionFile, [
      piSessionHeader('E:\\AI生成代码\\aiusage'),
      piAssistant('a-1', '2026-06-24T12:01:00.000Z', [
        toolCall('tc-1', 'subagent', { agent: 'pi-reviewer' }),
        toolCall('tc-2', 'bash', { command: 'ls' }),
        toolCall('tc-3', 'read', { path: 'E:\\x\\b.ts' }),
      ]),
    ]);

    const report = await build(['2026-06-24']);

    expect(report.topTools.map(row => row.label)).toContain('bash (openai-codex/pi)');
    expect(report.topTools.map(row => row.label)).toContain('read (openai-codex/pi)');
    expect(report.topAgents.map(row => row.label)).toContain('pi-reviewer (openai-codex/pi)');
  });

  it('includes Pi skills in topSkills ranking', async () => {
    await writeJsonl(sessionFile, [
      piSessionHeader('E:\\AI生成代码\\aiusage'),
      piAssistant('a-1', '2026-06-24T12:01:00.000Z', [
        toolCall('tc-1', 'read', { path: 'C:\\Users\\me\\.pi\\agent\\skills\\archify\\SKILL.md' }),
      ]),
    ]);

    const report = await build(['2026-06-24']);

    expect(report.topSkills.map(row => row.label)).toContain('archify (proxy)');
  });

  it('falls back provider to model inference when provider is missing or placeholder', async () => {
    await writeJsonl(sessionFile, [
      piSessionHeader('E:\\AI生成代码\\aiusage'),
      {
        type: 'message',
        id: 'm-1',
        timestamp: '2026-06-24T12:00:10.000Z',
        message: { role: 'user', model: 'claude-opus-4-1', content: [{ type: 'text', text: 'hello' }] },
      },
      {
        type: 'message',
        id: 'a-1',
        timestamp: '2026-06-24T12:01:00.000Z',
        message: { role: 'assistant', provider: '-', content: [toolCall('tc-1', 'edit', { path: 'x' })] },
      },
    ]);

    const report = await build(['2026-06-24']);

    expect(report.items.find(item => item.kind === 'user_message')?.provider).toBe('anthropic');
    expect(report.items.find(item => item.kind === 'tool_call')?.provider).toBe('inflection');
  });
});