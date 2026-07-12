import { getPricingCatalog } from '../utils/pricing.js';
import { CACHE_PRESETS, corsHeaders, withCacheHeaders } from '../utils/response.js';

export function handlePricingApi(): Response {
  const catalog = getPricingCatalog();
  return withCacheHeaders(new Response(JSON.stringify(catalog), {
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
    },
  }), CACHE_PRESETS.staticPublic);
}
