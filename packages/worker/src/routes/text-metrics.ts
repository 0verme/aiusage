import { buildWhere, parseFilters, TOTAL_TOKENS_SQL } from './overview.js';
import { CACHE_PRESETS, corsHeaders, jsonError, withCacheHeaders } from '../utils/response.js';
import type { Env } from '../types.js';

type TokenUnit = 'auto' | 'en' | 'zh' | 'raw';

export async function handleTextTokens(url: URL, env: Env): Promise<Response> {
  const filters = parseFilters(url);
  if (!filters) return jsonError(400, 'INVALID_PAYLOAD', 'Invalid range parameter', true);

  const unit = normalizeTokenUnit(url.searchParams.get('unit'));
  if (!unit) return jsonError(400, 'INVALID_PAYLOAD', 'Invalid unit parameter', true);

  const where = buildWhere(filters);
  const row = await env.DB.prepare(`
    SELECT COALESCE(SUM(${TOTAL_TOKENS_SQL}), 0) AS total_tokens
    FROM daily_usage_breakdown b
    ${where.whereClause}
  `).bind(...where.params).first<{ total_tokens: number }>();

  return withCacheHeaders(new Response(formatTokenCount(row?.total_tokens ?? 0, unit), {
    status: 200,
    headers: {
      ...corsHeaders(),
      'Content-Type': 'text/plain; charset=utf-8',
    },
  }), CACHE_PRESETS.dashboard);
}

export function normalizeTokenUnit(value: string | null): TokenUnit | null {
  if (!value) return 'auto';
  const unit = value.trim().toLowerCase();
  if (unit === 'auto' || unit === 'en' || unit === 'zh' || unit === 'raw') return unit;
  return null;
}

export function formatTokenCount(value: number, unit: TokenUnit = 'auto'): string {
  const count = Math.max(0, Math.round(Number(value || 0)));
  if (unit === 'raw') return String(count);
  if (unit === 'zh') return formatZh(count);
  return formatEn(count);
}

function formatEn(value: number): string {
  if (value >= 1_000_000_000) return `${formatScaled(value, 1_000_000_000)}B`;
  if (value >= 1_000_000) return `${formatScaled(value, 1_000_000)}M`;
  if (value >= 1_000) return `${formatScaled(value, 1_000)}K`;
  return String(value);
}

function formatZh(value: number): string {
  if (value >= 100_000_000) return `${formatScaled(value, 100_000_000)}亿`;
  if (value >= 10_000) return `${formatScaled(value, 10_000)}万`;
  return String(value);
}

function formatScaled(value: number, divisor: number): string {
  const scaled = Math.round((value / divisor) * 10) / 10;
  return Number.isInteger(scaled) ? String(scaled) : scaled.toFixed(1);
}
