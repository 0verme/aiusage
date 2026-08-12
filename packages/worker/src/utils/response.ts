export function corsHeaders(): HeadersInit {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export interface CacheHeaderOptions {
  maxAge: number;
  staleWhileRevalidate?: number;
  cdnMaxAge?: number;
  cdnStaleWhileRevalidate?: number;
}

export const CACHE_PRESETS = {
  dashboard: { maxAge: 60, staleWhileRevalidate: 300, cdnMaxAge: 300, cdnStaleWhileRevalidate: 3600 },
  trend: { maxAge: 300, staleWhileRevalidate: 600, cdnMaxAge: 900, cdnStaleWhileRevalidate: 3600 },
  staticPublic: { maxAge: 600, staleWhileRevalidate: 1800, cdnMaxAge: 3600, cdnStaleWhileRevalidate: 86400 },
} as const satisfies Record<string, CacheHeaderOptions>;

export function withCacheHeaders(response: Response, options: CacheHeaderOptions): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', cacheControl(options));
  if (options.cdnMaxAge !== undefined) {
    headers.set('Cloudflare-CDN-Cache-Control', cacheControl({
      maxAge: options.cdnMaxAge,
      staleWhileRevalidate: options.cdnStaleWhileRevalidate,
    }));
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function withNoStoreHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function jsonCached<T>(data: T, options: CacheHeaderOptions, isPublic = false): Response {
  return withCacheHeaders(jsonOk(data, isPublic), options);
}

export function jsonNoStore<T>(data: T, isPublic = false): Response {
  return withNoStoreHeaders(jsonOk(data, isPublic));
}

export function jsonOk<T>(data: T, isPublic = false): Response {
  const headers: HeadersInit = { 'Content-Type': 'application/json' };
  if (isPublic) Object.assign(headers, corsHeaders());
  return new Response(JSON.stringify({ ok: true, ...data }), { status: 200, headers });
}

export function jsonError(status: number, code: string, message: string, isPublic = false): Response {
  const headers: HeadersInit = { 'Content-Type': 'application/json' };
  if (isPublic) Object.assign(headers, corsHeaders());
  return new Response(
    JSON.stringify({ ok: false, error: { code, message } }),
    { status, headers },
  );
}

function cacheControl(options: CacheHeaderOptions): string {
  const directives = ['public', `max-age=${options.maxAge}`];
  if (options.staleWhileRevalidate !== undefined) {
    directives.push(`stale-while-revalidate=${options.staleWhileRevalidate}`);
  }
  return directives.join(', ');
}
