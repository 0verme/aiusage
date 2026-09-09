import { describe, expect, it } from 'vitest';
import { signDeviceToken } from '../utils/token.js';
import type { Env } from '../types.js';
import { handleMemoryIngest, handleMemoryOverview } from './memory.js';

const secret = 'memory-route-test-secret';

function memoryPayload() {
  const sourceRef = {
    source: 'pi',
    sourceSessionId: 'session-1',
    occurredAt: '2026-08-20T12:00:00.000Z',
    sourceRecordId: 'record-1',
  };
  return {
    schemaVersion: 'memory-v1',
    generatedAt: '2026-08-20T12:01:00.000Z',
    projects: [{
      projectId: 'project_demo',
      projectKey: 'remote:github.com/demo/repo',
      projectName: 'repo',
      firstSeenAt: sourceRef.occurredAt,
      lastSeenAt: sourceRef.occurredAt,
      status: 'ACTIVE' as const,
    }],
    workEvents: [{
      id: 'memory_event_1',
      fingerprint: 'event-fingerprint',
      source: 'pi',
      sourceSessionId: 'session-1',
      projectId: 'project_demo',
      eventType: 'implementation' as const,
      title: 'Implement schema',
      summary: 'Design the DWS schema',
      occurredAt: sourceRef.occurredAt,
      sourceRef,
      importance: 0.8,
      confidence: 0.75,
      createdAt: sourceRef.occurredAt,
    }],
    decisions: [{
      id: 'memory_decision_1',
      fingerprint: 'decision-fingerprint',
      projectId: 'project_demo',
      topic: 'schema',
      decision: 'CORE_ASSET_ONLY',
      reason: 'Coverage is insufficient',
      status: 'ACTIVE' as const,
      validFrom: sourceRef.occurredAt,
      sourceEventId: 'memory_event_1',
      sourceRef,
      confidence: 0.9,
      createdAt: sourceRef.occurredAt,
    }],
    projectStates: [{
      projectId: 'project_demo',
      summary: 'DWS schema is being designed',
      currentPhase: 'implementation' as const,
      recentProgress: ['Implement schema'],
      blockers: [],
      updatedAt: sourceRef.occurredAt,
      sourceEventId: 'memory_event_1',
      sourceRef,
    }],
    nextActions: [{
      id: 'memory_action_1',
      fingerprint: 'action-fingerprint',
      projectId: 'project_demo',
      content: 'Validate DEV214',
      status: 'OPEN' as const,
      sourceEventId: 'memory_event_1',
      sourceRef,
      createdAt: sourceRef.occurredAt,
    }],
  };
}

describe('memory ingest route', () => {
  it('keeps public Memory reads disabled by default', async () => {
    const response = await handleMemoryOverview(
      new URL('https://example.test/api/v1/public/memory'),
      { DB: {}, MEMORY_PUBLIC: 'false' } as unknown as Env,
    );

    expect(response.status).toBe(404);
  });

  it('accepts structured memory through its independent endpoint', async () => {
    const sql: string[] = [];
    const DB = {
      prepare(statement: string) {
        sql.push(statement);
        return {
          bind(..._params: unknown[]) {
            return {
              first: async <T>() => statement.includes('SELECT status, token_version')
                ? ({ status: 'active', token_version: 1 } as T)
                : null,
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
    const request = new Request('https://example.test/api/v1/memory/ingest', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        siteId: 'site-test',
        schemaVersion: 'memory-v1',
        generatedAt: '2026-08-20T12:01:00.000Z',
        device: {
          deviceId: 'device-test',
          hostname: 'test-host',
          timezone: 'UTC',
          appVersion: 'test',
        },
        memory: memoryPayload(),
      }),
    });

    const response = await handleMemoryIngest(request, {
      DB,
      DEVICE_TOKEN_SECRET: secret,
    } as unknown as Env);
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.projectsProcessed).toBe(1);
    expect(sql.some((statement) => statement.includes('memory_work_event'))).toBe(true);
    expect(sql.some((statement) => statement.includes('memory_decision'))).toBe(true);
  });
});
