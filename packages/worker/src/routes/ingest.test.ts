import { describe, expect, it } from 'vitest';
import { signDeviceToken } from '../utils/token.js';
import type { Env } from '../types.js';
import { canonicalizeIngestBreakdown, handleIngest } from './ingest.js';

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
