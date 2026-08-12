import { handleHealth } from './routes/health.js';
import { handleEnroll } from './routes/enroll.js';
import { handleIngest } from './routes/ingest.js';
import { handleOverview } from './routes/overview.js';
import { handleBreakdowns } from './routes/breakdowns.js';
import { handlePricingApi } from './routes/pricing-api.js';
import { handleTextTokens } from './routes/text-metrics.js';
import { corsHeaders, jsonError, withCacheHeaders, withNoStoreHeaders } from './utils/response.js';
import type { Env } from './types.js';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const isHead = request.method === 'HEAD';

    if (request.method === 'OPTIONS' && pathname.startsWith('/api/v1/public/')) {
      return withNoStoreHeaders(new Response(null, { status: 204, headers: corsHeaders() }));
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return withNoStoreHeaders(await handleMutableRequest(request, env, url));
    }

    if (pathname.startsWith('/api/') && env.RATE_LIMITER) {
      try {
        const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
        const { success } = await env.RATE_LIMITER.limit({ key: ip });
        if (!success) {
          return withNoStoreHeaders(new Response(
            JSON.stringify({ ok: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } }),
            { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '60' } },
          ));
        }
      } catch (err) {
        console.warn('Rate limiter unavailable, skipping check', err);
      }
    }

    try {
      if (pathname === '/api/v1/health') {
        return headAware(handleHealth(env), isHead);
      }

      if (pathname === '/api/v1/public/overview') {
        return headAware(await handleOverview(url, env), isHead);
      }
      if (pathname === '/api/v1/public/breakdowns') {
        return headAware(await handleBreakdowns(url, env), isHead);
      }
      if (pathname === '/api/v1/public/pricing') {
        return headAware(handlePricingApi(), isHead);
      }
      if (pathname === '/api/v1/public/text/tokens') {
        return headAware(await handleTextTokens(url, env), isHead);
      }

      if (pathname.startsWith('/api/')) {
        return headAware(withNoStoreHeaders(jsonError(404, 'NOT_FOUND', 'API route not found')), isHead);
      }

      return maybeCacheAsset(pathname, await env.ASSETS.fetch(request));
    } catch (err) {
      console.error('Unhandled error:', err);
      return withNoStoreHeaders(jsonError(500, 'INTERNAL_ERROR', 'Internal server error'));
    }
  },
} satisfies ExportedHandler<Env>;

async function handleMutableRequest(request: Request, env: Env, url: URL): Promise<Response> {
  const { pathname } = url;
  try {
    if (pathname === '/api/v1/enroll' && request.method === 'POST') {
      return handleEnroll(request, env);
    }
    if (pathname === '/api/v1/ingest/daily' && request.method === 'POST') {
      return handleIngest(request, env);
    }
    if (pathname.startsWith('/api/')) {
      return jsonError(404, 'NOT_FOUND', 'API route not found');
    }
    return env.ASSETS.fetch(request);
  } catch (err) {
    console.error('Unhandled error:', err);
    return jsonError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}

function headAware(response: Response, isHead: boolean): Response {
  if (!isHead) return response;
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function maybeCacheAsset(pathname: string, response: Response): Response {
  if (pathname !== '/') return response;
  return withCacheHeaders(response, { maxAge: 60, staleWhileRevalidate: 300 });
}
