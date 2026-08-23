import { getPricingCatalog } from '../utils/pricing.js';
import { corsHeaders, withNoStoreHeaders } from '../utils/response.js';

export function handlePricingApi(): Response {
  const catalog = getPricingCatalog();
  return withNoStoreHeaders(new Response(JSON.stringify(catalog), {
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
    },
  }));
}
