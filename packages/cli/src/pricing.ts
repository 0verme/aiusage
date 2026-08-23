import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  catalog as bundledCatalog,
  isPricingVersionOlder,
  type PricingCatalog,
} from '@aiusage/shared';
import type { AIUsageConfig, SyncTarget } from './config.js';

const CACHE_DIR = join(homedir(), '.aiusage');
const CACHE_PATH = join(CACHE_DIR, 'pricing-cache.json');
const FETCH_TIMEOUT_MS = 5000;

export type PricingSource = 'remote' | 'cache' | 'bundled';

export interface PricingInfo {
  source: PricingSource;
  version: string;
  url?: string;
  fetchedAt?: string;
  warnings?: string[];
}

export interface ResolvedPricingCatalog {
  catalog: PricingCatalog;
  info: PricingInfo;
}

interface PricingCacheFile {
  fetchedAt: string;
  sourceUrl: string;
  catalog: PricingCatalog;
}

export function getPricingCachePath(): string {
  return CACHE_PATH;
}

export async function resolvePricingCatalog(
  config: AIUsageConfig,
  options: { forceRefresh?: boolean; explicitUrl?: string; target?: SyncTarget } = {},
): Promise<ResolvedPricingCatalog> {
  const mode = config.pricing?.mode ?? 'auto';
  const cache = await readPricingCache();

  // A target Worker is the authority. Never let a fresh cache silently mask it;
  // cache is only a fallback after the network path has failed.
  if (mode !== 'offline' || options.forceRefresh) {
    for (const url of getPricingUrls(config, options)) {
      try {
        const catalog = await fetchPricingCatalog(url);
        const fetchedAt = new Date().toISOString();
        await writePricingCache({ fetchedAt, sourceUrl: url, catalog });
        const warnings = isPricingVersionOlder(catalog.version, bundledCatalog.version)
          ? [`Remote pricing ${catalog.version} is older than bundled ${bundledCatalog.version}.`]
          : [];
        return {
          catalog,
          info: withWarnings({ source: 'remote', version: catalog.version, url, fetchedAt }, warnings),
        };
      } catch {
        // Pricing refresh is best-effort; reporting must remain available offline.
      }
    }
  }

  if (cache) {
    if (isPricingVersionOlder(cache.catalog.version, bundledCatalog.version)) {
      return {
        catalog: bundledCatalog,
        info: withWarnings(
          { source: 'bundled', version: bundledCatalog.version },
          [`Ignored stale pricing cache ${cache.catalog.version}; bundled catalog ${bundledCatalog.version} is newer.`],
        ),
      };
    }
    const warnings = mode === 'offline'
      ? ['Offline mode selected; using the cached catalog without a network refresh.']
      : ['Pricing network refresh failed; using cached catalog.'];
    return { catalog: cache.catalog, info: fromCacheInfo(cache, warnings) };
  }

  return { catalog: bundledCatalog, info: { source: 'bundled', version: bundledCatalog.version } };
}

export async function getPricingStatus(config: AIUsageConfig) {
  const cache = await readPricingCache();
  return {
    mode: config.pricing?.mode ?? 'auto',
    configuredUrl: config.pricing?.url,
    cachePath: CACHE_PATH,
    cache: cache ? {
      version: cache.catalog.version,
      sourceUrl: cache.sourceUrl,
      fetchedAt: cache.fetchedAt,
    } : undefined,
    bundled: { version: bundledCatalog.version },
  };
}

function getPricingUrls(
  config: AIUsageConfig,
  options: { explicitUrl?: string; target?: SyncTarget },
): string[] {
  const targetUrl = options.target?.apiBaseUrl
    ? `${options.target.apiBaseUrl}/api/v1/public/pricing`
    : undefined;
  const urls = [
    targetUrl,
    options.explicitUrl,
    config.pricing?.url,
  ].filter((url): url is string => Boolean(url));
  return [...new Set(urls.map(url => url.trim()).filter(Boolean))];
}

function fromCacheInfo(cache: PricingCacheFile, warnings: string[] = []): PricingInfo {
  return withWarnings({
    source: 'cache',
    version: cache.catalog.version,
    url: cache.sourceUrl,
    fetchedAt: cache.fetchedAt,
  }, warnings);
}

function withWarnings<T extends PricingInfo>(info: T, warnings: string[]): T {
  return warnings.length > 0 ? { ...info, warnings } : info;
}

async function readPricingCache(): Promise<PricingCacheFile | null> {
  try {
    const cache = JSON.parse(await readFile(CACHE_PATH, 'utf-8')) as PricingCacheFile;
    assertPricingCatalog(cache.catalog);
    if (!cache.fetchedAt || !cache.sourceUrl) return null;
    return cache;
  } catch {
    return null;
  }
}

async function writePricingCache(cache: PricingCacheFile): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`, 'utf-8');
}

async function fetchPricingCatalog(url: string): Promise<PricingCatalog> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`pricing fetch failed: ${response.status}`);
  const data: unknown = await response.json();
  assertPricingCatalog(data);
  return data;
}

function assertPricingCatalog(value: unknown): asserts value is PricingCatalog {
  const catalog = value as PricingCatalog | undefined;
  if (!catalog || typeof catalog !== 'object') throw new Error('invalid pricing catalog');
  if (!catalog.version || typeof catalog.version !== 'string') throw new Error('invalid pricing catalog version');
  if (!catalog.providers || typeof catalog.providers !== 'object') throw new Error('invalid pricing catalog providers');
  if (!catalog.providers.openai?.codex?.models) throw new Error('invalid OpenAI pricing catalog');
}
