import { describe, expect, it } from 'vitest';
import { signDeviceToken } from '../utils/token.js';
import type { Env } from '../types.js';
import { canonicalizeIngestBreakdown, handleIngest, replaceActivityMetrics } from './ingest.js';

const secret = 'provider-canonicalization-test-secret';

function baseBreakdown(provider: string) {
  return {
    provider,
    product: 'codex' as const,
    channel: 'cli' as const,
    model: 'gpt-5.6-sol',
    project: '/workspace/demo',
    eventCount: 1,
    inputTokens: 100,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 20,
    reasoningOutputTokens: 0,
  };
}

describe('ingest provider canonicalization', () => {
  it('canonicalizes an old OpenAI Codex payload before storage', () => {
    expect(canonicalizeIngestBreakdown(baseBreakdown('openai-codex'))).toMatchObject({
      provider: 'openai',
      product: 'codex',
    });
  });

  it('does not write openai-codex when an old client uploads that alias', async () => {
    const breakdownBinds: unknown[][] = [];
    const DB = {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            if (sql.includes('INSERT INTO daily_usage_breakdown')) breakdownBinds.push(params);
            return {
              first: async <T>() => {
                if (sql.includes('SELECT status, token_version')) {
                  return { status: 'active', token_version: 1 } as T;
                }
                return null;
              },
              all: async <T>() => ({ results: [] as T[] }),
              run: async () => ({ success: true }),
            };
          },
        };
      },
    };
    const token = await signDeviceToken({
      siteId: 'site-test',
      deviceId: 'device-test',
      tokenVersion: 1,
      issuedAt: '2026-08-20T12:00:00.000Z',
    }, secret);
    const request = new Request('https://example.test/api/v1/ingest', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        siteId: 'site-test',
        schemaVersion: '1',
        generatedAt: '2026-08-20T12:00:00.000Z',
        device: {
          deviceId: 'device-test',
          hostname: 'test-host',
          timezone: 'UTC',
          appVersion: 'legacy-client',
        },
        days: [{
          usageDate: '2026-08-20',
          breakdowns: [baseBreakdown('openai-codex')],
        }],
      }),
    });

    const response = await handleIngest(request, {
      DB,
      DEVICE_TOKEN_SECRET: secret,
    } as unknown as Env);

    expect(response.status).toBe(200);
    expect(breakdownBinds).toHaveLength(1);
    expect(breakdownBinds[0]?.[2]).toBe('openai');
    expect(breakdownBinds[0]?.[3]).toBe('codex');
    expect(JSON.parse(String(breakdownBinds[0]?.[19])).raw_providers).toEqual(['openai-codex']);
  });
});

describe('Pi activity ingest', () => {
  it('writes product=pi activity items into daily_activity_breakdown', async () => {
    const activityBinds: unknown[][] = [];
    const DB = {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            if (sql.includes('INSERT INTO daily_activity_breakdown')) activityBinds.push(params);
            return {
              first: async () => null,
              run: async () => ({ success: true }),
            };
          },
        };
      },
    };

    await replaceActivityMetrics(
      { DB } as unknown as Env,
      'device-test',
      '2026-08-20',
      [
        {
          provider: 'openai-codex',
          product: 'pi',
          source: 'openai-codex/pi',
          project: '/workspace/demo',
          kind: 'tool_call',
          name: 'bash',
          count: 5,
          confidence: 'exact',
        },
        {
          provider: 'openai-codex',
          product: 'pi',
          source: 'openai-codex/pi',
          project: '/workspace/demo',
          kind: 'skill_proxy',
          name: 'security-review',
          count: 1,
          confidence: 'proxy',
        },
        {
          provider: 'openai-codex',
          product: 'pi',
          source: 'openai-codex/pi',
          project: '/workspace/demo',
          kind: 'agent_call',
          name: 'subagent',
          count: 1,
          confidence: 'exact',
        },
      ],
      '2026-08-20T12:00:00.000Z',
    );

    expect(activityBinds).toHaveLength(3);
    // [device_id, usage_date, provider, product, source, project, ...]
    expect(activityBinds[0]?.[0]).toBe('device-test');
    expect(activityBinds[0]?.[1]).toBe('2026-08-20');
    expect(activityBinds[0]?.[2]).toBe('openai');
    expect(activityBinds[0]?.[3]).toBe('pi');
    expect(activityBinds[0]?.[4]).toBe('openai-codex/pi');
    expect(activityBinds[0]?.[8]).toBe('tool_call');
    expect(activityBinds[0]?.[9]).toBe('bash');
    expect(activityBinds[0]?.[10]).toBe('exact');
    expect(activityBinds[0]?.[11]).toBe(5);
    expect(activityBinds[1]?.[8]).toBe('skill_proxy');
    expect(activityBinds[1]?.[9]).toBe('security-review');
    expect(activityBinds[1]?.[10]).toBe('proxy');
    expect(activityBinds[2]?.[8]).toBe('agent_call');
    expect(activityBinds[2]?.[9]).toBe('subagent');
  });
});
