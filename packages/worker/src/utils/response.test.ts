import { describe, expect, it } from 'vitest';
import { CACHE_PRESETS, jsonCached } from './response.js';

describe('public response caching', () => {
  it('sets independent browser and Cloudflare CDN cache policies', () => {
    const response = jsonCached({ value: 1 }, CACHE_PRESETS.dashboard, true);

    expect(response.headers.get('Cache-Control')).toBe(
      'public, max-age=60, stale-while-revalidate=300',
    );
    expect(response.headers.get('Cloudflare-CDN-Cache-Control')).toBe(
      'public, max-age=300, stale-while-revalidate=3600',
    );
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});
