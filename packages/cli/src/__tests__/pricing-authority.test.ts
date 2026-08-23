import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

const state = vi.hoisted(() => ({
  home: 'C:/aiusage-pricing-test',
  files: new Map<string, string>(),
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => state.home };
});

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  readFile: vi.fn(async (path: string) => {
    const value = state.files.get(path);
    if (value === undefined) throw new Error('ENOENT');
    return value;
  }),
  writeFile: vi.fn(async (path: string, value: string) => {
    state.files.set(path, value);
  }),
}));

const { catalog } = await import('@aiusage/shared');
const { resolvePricingCatalog } = await import('../pricing.js');

function cacheFile(version: string, sourceUrl = 'https://old.example/pricing'): string {
  return JSON.stringify({
    fetchedAt: '2026-07-26T00:00:00.000Z',
    sourceUrl,
    catalog: { ...catalog, version },
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  state.files.clear();
});

describe('pricing authority and cache freshness', () => {
  it('prefers the target Worker over an existing cache', async () => {
    const cachePath = join(state.home, '.aiusage', 'pricing-cache.json');
    state.files.set(cachePath, cacheFile('2026-07-26-legacy-v1'));
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(catalog), {
      status: url.includes('/api/v1/public/pricing') ? 200 : 404,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const resolved = await resolvePricingCatalog(
      { targets: [{ name: 'production', apiBaseUrl: 'https://token.example' }] },
      { target: { name: 'production', apiBaseUrl: 'https://token.example' } },
    );

    expect(resolved.info.source).toBe('remote');
    expect(resolved.info.url).toBe('https://token.example/api/v1/public/pricing');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://token.example/api/v1/public/pricing',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    );
  });

  it('ignores a stale cache in favor of the newer bundled catalog after network failure', async () => {
    const cachePath = join(state.home, '.aiusage', 'pricing-cache.json');
    state.files.set(cachePath, cacheFile('2026-07-26-legacy-v1'));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));

    const resolved = await resolvePricingCatalog({
      pricing: { url: 'https://pricing.example/catalog.json' },
    });

    expect(resolved.info.source).toBe('bundled');
    expect(resolved.catalog.version).toBe(catalog.version);
    expect(resolved.info.warnings?.[0]).toContain('Ignored stale pricing cache');
  });

  it('uses a newer cache as an explicit fallback and reports fetchedAt', async () => {
    const cachePath = join(state.home, '.aiusage', 'pricing-cache.json');
    state.files.set(cachePath, cacheFile('2026-08-24-future-v1'));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));

    const resolved = await resolvePricingCatalog({
      pricing: { url: 'https://pricing.example/catalog.json' },
    });

    expect(resolved.info.source).toBe('cache');
    expect(resolved.info.version).toBe('2026-08-24-future-v1');
    expect(resolved.info.fetchedAt).toBe('2026-07-26T00:00:00.000Z');
    expect(resolved.info.warnings?.[0]).toContain('cached catalog');
  });
});
