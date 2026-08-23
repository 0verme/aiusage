import { describe, expect, it } from 'vitest';
import { PRICING_VERSION } from '@aiusage/shared';
import { handlePricingApi } from './pricing-api.js';

describe('pricing API', () => {
  it('is an uncached current pricing authority response', async () => {
    const response = handlePricingApi();
    const body = await response.json() as { version: string };

    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(body.version).toBe(PRICING_VERSION);
  });
});
