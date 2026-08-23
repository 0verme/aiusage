import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const mockHomedir = vi.fn();

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => mockHomedir(),
  };
});

let homeDir: string;

beforeEach(async () => {
  homeDir = join(tmpdir(), `aiusage-report-${Date.now()}`);
  mockHomedir.mockReturnValue(homeDir);
  vi.stubEnv('CLAUDE_CONFIG_DIR', '');
  vi.stubEnv('CODEX_HOME', '');
  vi.stubEnv('CODEX_CONFIG_DIR', '');
  vi.stubEnv('PI_CODING_AGENT_DIR', '');
  await mkdir(homeDir, { recursive: true });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(homeDir, { recursive: true, force: true });
});

describe('buildLocalReport', () => {
  it('discovers all-history dates from CLAUDE_CONFIG_DIR and the default directory together', async () => {
    const customRoot = join(homeDir, 'custom-claude');
    vi.stubEnv('CLAUDE_CONFIG_DIR', customRoot);
    const customProject = join(customRoot, 'projects', 'custom-project');
    const defaultProject = join(homeDir, '.claude', 'projects', 'default-project');
    await mkdir(customProject, { recursive: true });
    await mkdir(defaultProject, { recursive: true });
    const usage = (timestamp: string, requestId: string, cwd: string) => JSON.stringify({
      timestamp,
      requestId,
      cwd,
      message: {
        id: `msg_${requestId}`,
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 100, output_tokens: 20 },
      },
    });
    await writeFile(join(customProject, 'custom.jsonl'), usage('2026-07-21T12:00:00Z', 'custom', '/work/custom'));
    await writeFile(join(defaultProject, 'default.jsonl'), usage('2026-07-09T12:00:00Z', 'default', '/work/default'));

    const { buildLocalReport } = await import('../report.js');
    const report = await buildLocalReport('all', { tools: ['claude-code'] });

    expect(report.daily.map(day => day.usageDate)).toEqual(['2026-07-09', '2026-07-21']);
    expect(report.totals.eventCount).toBe(2);
  });

  it('discovers custom Pi and Oh My Pi session roots for all-history reports', async () => {
    const customPiRoot = join(homeDir, 'custom-pi');
    const customSessions = join(customPiRoot, 'sessions', 'encoded-custom');
    const ompSessions = join(homeDir, '.omp', 'agent', 'sessions', 'encoded-omp');
    vi.stubEnv('PI_CODING_AGENT_DIR', customPiRoot);
    await mkdir(customSessions, { recursive: true });
    await mkdir(ompSessions, { recursive: true });

    const usage = (id: string, timestamp: string, cwd: string) => [
      JSON.stringify({ type: 'session', id: `${id}-session`, cwd }),
      JSON.stringify({
        type: 'message',
        id,
        timestamp,
        message: { role: 'assistant', model: 'gpt-5.6-luna', provider: 'openai-codex', usage: { input: 100, output: 20 } },
      }),
    ].join('\n');
    await writeFile(join(customSessions, 'custom.jsonl'), usage('custom', '2026-07-21T12:00:00Z', '/work/custom'));
    await writeFile(join(ompSessions, 'omp.jsonl'), usage('omp', '2026-07-22T12:00:00Z', '/work/omp'));

    const { buildLocalReport } = await import('../report.js');
    const report = await buildLocalReport('all', { tools: ['pi'] });

    expect(report.daily.map(day => day.usageDate)).toEqual(['2026-07-21', '2026-07-22']);
    expect(report.totals.eventCount).toBe(2);
    expect(report.totals.totalTokens).toBe(240);
  });

  it('discovers Gemini logs, Copilot VS Code workspace sessions, and Antigravity metadata in all-history reports', async () => {
    await mkdir(join(homeDir, '.gemini', 'tmp', 'project-a'), { recursive: true });
    await writeFile(
      join(homeDir, '.gemini', 'tmp', 'project-a', 'logs.json'),
      JSON.stringify([
        { type: 'user', timestamp: '2025-06-30T12:38:58.048Z' },
      ], null, 2),
    );

    await writeFile(
      join(homeDir, '.gemini', 'tmp', 'project-a', 'session.json'),
      JSON.stringify({
        data: {
          model: 'gemini-2.5-pro',
          messages: [
            {
              timestamp: '2025-09-17T12:40:13.941Z',
              usageMetadata: {
                promptTokenCount: 100,
                candidatesTokenCount: 50,
                cachedContentTokenCount: 20,
                thoughtsTokenCount: 5,
              },
            },
          ],
        },
      }, null, 2),
    );

    const workspaceDir = join(homeDir, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage', 'ws-1');
    await mkdir(join(workspaceDir, 'chatSessions'), { recursive: true });
    await writeFile(
      join(workspaceDir, 'workspace.json'),
      JSON.stringify({ folder: 'file:///Users/test/Copilot%20Project' }, null, 2),
    );
    await writeFile(
      join(workspaceDir, 'chatSessions', 'session-1.json'),
      JSON.stringify({
        requests: [
          {
            requestId: 'copilot-1',
            response: [{ value: 'Done' }],
            timestamp: Date.parse('2025-10-22T12:45:42.785Z'),
            modelId: 'copilot/claude-sonnet-4.5',
          },
        ],
      }, null, 2),
    );

    await mkdir(join(homeDir, '.gemini', 'antigravity', 'brain', 'session-a'), { recursive: true });
    await writeFile(
      join(homeDir, '.gemini', 'antigravity', 'brain', 'session-a', 'task.md.metadata.json'),
      JSON.stringify({ updatedAt: '2025-12-10T12:36:31.732646Z' }, null, 2),
    );

    const { buildLocalReport } = await import('../report.js');
    const report = await buildLocalReport('all');

    expect(report.daily.map((day) => day.usageDate)).toEqual([
      '2025-06-30',
      '2025-09-17',
      '2025-10-22',
      '2025-12-10',
    ]);
    expect(report.daysWithData).toBe(4);
  });

  it('discovers and reports Kimi Code usage from time-based usage.record lines', async () => {
    const sessionDir = join(
      homeDir,
      '.kimi-code',
      'sessions',
      'wd_aiusage_123456789abc',
      'session-1',
    );
    const agentDir = join(sessionDir, 'agents', 'main');
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(sessionDir, 'state.json'),
      JSON.stringify({ workDir: '/Users/test/Projects/AI/aiusage' }),
    );
    await writeFile(
      join(agentDir, 'wire.jsonl'),
      JSON.stringify({
        type: 'usage.record',
        model: 'kimi-code/k3',
        usage: {
          inputOther: 1_000_000,
          output: 100_000,
          inputCacheRead: 2_000_000,
          inputCacheCreation: 0,
        },
        usageScope: 'turn',
        time: Date.parse('2026-07-17T12:00:00Z'),
      }),
    );

    const { buildLocalReport } = await import('../report.js');
    const report = await buildLocalReport('all');

    expect(report.daily.map(day => day.usageDate)).toEqual(['2026-07-17']);
    expect(report.bySource).toContainEqual(
      expect.objectContaining({
        source: 'moonshot/kimi-code',
        eventCount: 1,
        inputTokens: 1_000_000,
        cachedInputTokens: 2_000_000,
        outputTokens: 100_000,
      }),
    );
  });

  it('limits all-history discovery and output to the selected Trae edition', async () => {
    const traeDir = join(homeDir, '.aiusage', 'trae-cache', 'sessions');
    const geminiDir = join(homeDir, '.gemini', 'tmp', 'other-project');
    await Promise.all([
      mkdir(traeDir, { recursive: true }),
      mkdir(geminiDir, { recursive: true }),
    ]);
    await writeFile(join(traeDir, 'session.json'), JSON.stringify({
      schemaVersion: 1,
      source: 'trae-cn-local-rpc',
      syncedAt: '2026-07-19T00:00:00Z',
      sessionId: 'trae-session',
      project: '/Users/test/Projects/trae',
      events: [{
        messageId: 'trae-message',
        timestamp: '2026-01-15T12:00:00Z',
        model: 'GPT-5.4',
        inputTokens: 100,
        cachedInputTokens: 200,
        cacheWriteTokens: 0,
        outputTokens: 10,
        reasoningOutputTokens: 0,
      }],
    }));
    await writeFile(join(geminiDir, 'session.json'), JSON.stringify({
      data: {
        model: 'gemini-2.5-pro',
        messages: [{
          timestamp: '2025-01-01T12:00:00Z',
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }],
      },
    }));

    const { buildLocalReport } = await import('../report.js');
    const report = await buildLocalReport('all', { tools: ['trae-cn'] });

    expect(report.requestedDays).toBe(1);
    expect(report.daily.map(day => day.usageDate)).toEqual(['2026-01-15']);
    expect(report.bySource.map(source => source.source)).toEqual(['openai/trae-cn']);
    expect(report.totals.totalTokens).toBe(310);
  });
});

describe('Trae CLI filters', () => {
  it('supports the 6-month range and expands the Trae alias to both editions', async () => {
    const { parseReportRange } = await import('../report.js');
    const { parseToolSelection } = await import('../scan.js');

    expect(parseReportRange('6m')).toBe('6m');
    expect(parseToolSelection('trae')).toEqual(['trae-cn', 'trae-intl', 'trae']);
    expect(parseToolSelection('trae-cn,trae-intl')).toEqual(['trae-cn', 'trae-intl']);
  });
});

describe('calculateBreakdownCost', () => {
  it('prices local Codex GPT-5.5 usage', async () => {
    const { calculateBreakdownCost } = await import('../report.js');
    const warnings = new Set<string>();

    const cost = calculateBreakdownCost({
      provider: 'openai',
      product: 'codex',
      channel: 'cli',
      model: 'gpt-5.5',
      project: '/tmp/project',
      eventCount: 1,
      inputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      cacheWriteTokens: 0,
      outputTokens: 500_000,
      reasoningOutputTokens: 0,
    }, warnings);

    expect(cost).toBe(33.5);
    expect([...warnings]).toEqual([]);
  });

  it('trusts OpenCode provider-reported cost', async () => {
    const { calculateBreakdownCost } = await import('../report.js');
    const warnings = new Set<string>();

    const cost = calculateBreakdownCost({
      provider: 'openai',
      product: 'opencode',
      channel: 'cli',
      model: 'gpt-5.6',
      project: '/tmp/project',
      eventCount: 1,
      inputTokens: 100,
      cachedInputTokens: 20,
      cacheWriteTokens: 0,
      outputTokens: 10,
      reasoningOutputTokens: 0,
      costUSD: 0.42,
      pricingVersion: 'opencode-provider',
    }, warnings);

    expect(cost).toBe(0.42);
    expect([...warnings]).toEqual([]);
  });

  it('trusts Trae international vendor cost across catalog versions', async () => {
    const { calculateBreakdownCost } = await import('../report.js');
    const { catalog } = await import('@aiusage/shared');
    const warnings = new Set<string>();

    const cost = calculateBreakdownCost({
      provider: 'openai',
      product: 'trae-intl',
      channel: 'ide',
      model: 'gpt-5.4',
      project: 'unknown',
      eventCount: 1,
      inputTokens: 100,
      cachedInputTokens: 200,
      cacheWriteTokens: 0,
      outputTokens: 20,
      reasoningOutputTokens: 0,
      costUSD: 0.25,
      pricingVersion: 'older-cli',
    }, warnings, { ...catalog, version: 'future-catalog' });

    expect(cost).toBe(0.25);
    expect([...warnings]).toEqual([]);
  });

  it('estimates Codex auto-review with gpt-5.4 pricing', async () => {
    const { calculateBreakdownCost } = await import('../report.js');
    const warnings = new Set<string>();

    const cost = calculateBreakdownCost({
      provider: 'openai',
      product: 'codex',
      channel: 'cli',
      model: 'codex-auto-review',
      project: '/tmp/project',
      eventCount: 1,
      inputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      cacheWriteTokens: 0,
      outputTokens: 1_000_000,
      reasoningOutputTokens: 0,
    }, warnings);

    expect(cost).toBe(28);
    // codex-auto-review 是 catalog 里的显式 alias → gpt-5.4，按 exact 处理，不应有 warning
    expect([...warnings]).toEqual([]);
  });
});
