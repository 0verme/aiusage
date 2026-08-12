import { describe, expect, it } from 'vitest';
import { catalog } from '@aiusage/shared';
import { getPricingStatus, resolvePricingCatalog } from '../pricing.js';

describe('remote pricing catalog', () => {
  it('falls back to the bundled catalog in offline mode', async () => {
    const resolved = await resolvePricingCatalog({ pricing: { mode: 'offline' } });
    expect(resolved.info).toEqual({ source: 'bundled', version: catalog.version });
    expect(resolved.catalog).toBe(catalog);
  });

  it('reports configured mode and bundled version', async () => {
    const status = await getPricingStatus({ pricing: { mode: 'manual', url: 'https://example.com/catalog.json' } });
    expect(status.mode).toBe('manual');
    expect(status.configuredUrl).toBe('https://example.com/catalog.json');
    expect(status.bundled.version).toBe(catalog.version);
  });
});
