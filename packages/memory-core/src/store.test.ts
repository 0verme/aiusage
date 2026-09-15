import { describe, expect, it } from 'vitest';
import { RuleBasedMemoryExtractor, resolveProjectIdentity, emptyMemoryStore, mergeMemoryExtraction } from './index.js';
import type { NormalizedSession } from './types.js';

function session(text: string, id: string, timestamp: string): NormalizedSession {
  const project = resolveProjectIdentity({
    cwd: '/workspace/lakehouse-toolkit-wt-45',
    repositoryRoot: '/workspace/lakehouse-toolkit-wt-45',
    gitCommonDir: '/workspace/lakehouse-toolkit/.git',
    remoteUrl: 'git@github.com:0verme/lakehouse-toolkit.git',
  });
  return {
    source: 'pi',
    sessionId: id,
    project,
    startedAt: timestamp,
    endedAt: timestamp,
    models: [],
    toolNames: [],
    messages: [{
      id: `${id}-message`,
      role: 'user',
      text,
      timestamp,
      sourceRef: {
        source: 'pi',
        sourceSessionId: id,
        occurredAt: timestamp,
        sourceRecordId: `${id}-message`,
        projectPath: '/workspace/lakehouse-toolkit-wt-45',
      },
    }],
  };
}

describe('memory store merge', () => {
  it('is idempotent and preserves decision supersession history', () => {
    const extractor = new RuleBasedMemoryExtractor();
    const first = extractor.extract(session(
      '决定不引入 platform/catalog，因为元数据覆盖率不足。',
      'session-1',
      '2026-08-20T12:00:00.000Z',
    ));
    const repeat = extractor.extract(session(
      '决定不引入 platform/catalog，因为元数据覆盖率不足。',
      'session-1',
      '2026-08-20T12:00:00.000Z',
    ));
    const changed = extractor.extract(session(
      '决定引入 catalog，因为现在需要统一元数据入口。',
      'session-2',
      '2026-08-21T12:00:00.000Z',
    ));

    let store = emptyMemoryStore();
    store = mergeMemoryExtraction(store, first).snapshot;
    store = mergeMemoryExtraction(store, repeat).snapshot;
    store = mergeMemoryExtraction(store, changed).snapshot;

    expect(store.workEvents).toHaveLength(2);
    expect(store.decisions).toHaveLength(2);
    expect(store.decisions.filter((decision) => decision.status === 'SUPERSEDED')).toHaveLength(1);
    expect(store.decisions.find((decision) => decision.status === 'ACTIVE')?.decision).toContain('引入 catalog');
  });
});
