import { hostname } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AIUsageConfig } from './config.js';
import { getLocalTimezone } from './config.js';
import { getVersion } from './version.js';

const SCHEMA_VERSION = '1.0';
const DEFAULT_LOOKBACK_DAYS = 7;
const execFileAsync = promisify(execFile);

export interface HealthResponse {
  ok: boolean;
  siteId: string;
  service: 'aiusage';
  version: string;
  time: string;
}

interface EnrollResponse {
  ok: boolean;
  siteId: string;
  deviceId: string;
  deviceToken: string;
  issuedAt: string;
}

interface ApiErrorResponse {
  ok: false;
  error?: {
    code?: string;
    message?: string;
  };
}

export async function fetchHealth(apiBaseUrl: string): Promise<HealthResponse> {
  return requestJson<HealthResponse>(`${apiBaseUrl}/api/v1/health`);
}

export async function enrollDevice(
  apiBaseUrl: string,
  params: {
    siteId: string;
    deviceId: string;
    deviceAlias?: string;
    enrollToken: string;
  },
): Promise<EnrollResponse> {
  return requestJson<EnrollResponse>(`${apiBaseUrl}/api/v1/enroll`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.enrollToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      siteId: params.siteId,
      deviceId: params.deviceId,
      deviceAlias: params.deviceAlias,
      hostname: hostname(),
      timezone: getLocalTimezone(),
      appVersion: getVersion(),
    }),
  });
}

export async function uploadDailyUsage(
  apiBaseUrl: string,
  config: Pick<AIUsageConfig, 'siteId' | 'deviceId' | 'deviceAlias' | 'deviceToken'>,
  days: Array<{
    usageDate: string;
    breakdowns: Array<{
      provider: string;
      product: string;
      channel: string;
      model: string;
      project: string;
      eventCount: number;
      inputTokens: number;
      cachedInputTokens: number;
      cacheWriteTokens: number;
      outputTokens: number;
      reasoningOutputTokens: number;
    }>;
  }>,
): Promise<{
  ok: boolean;
  daysProcessed: number;
  costSummary: Record<string, { estimatedCostUsd: number; costStatus: string }>;
}> {
  return requestJson(`${apiBaseUrl}/api/v1/ingest/daily`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.deviceToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      siteId: config.siteId,
      schemaVersion: SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      device: {
        deviceId: config.deviceId,
        deviceAlias: config.deviceAlias,
        hostname: hostname(),
        timezone: getLocalTimezone(),
        appVersion: getVersion(),
      },
      days,
    }),
  });
}

export function defaultLookbackDays(config: AIUsageConfig): number {
  return config.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await requestWithProxySupport(url, init);
  const text = await response.text();

  let data: T | ApiErrorResponse | null = null;
  if (text) {
    try {
      data = JSON.parse(text) as T | ApiErrorResponse;
    } catch {
      throw new Error(`服务端返回了非 JSON 响应 (${response.status})`);
    }
  }

  if (!response.ok) {
    const error = (data as ApiErrorResponse | null)?.error;
    throw new Error(error?.message ?? `请求失败 (${response.status})`);
  }

  if (!data) {
    throw new Error('服务端返回了空响应');
  }

  return data as T;
}

async function requestWithProxySupport(url: string, init?: RequestInit): Promise<ResponseLike> {
  const targetUrl = new URL(url);
  const proxyUrl = getProxyUrl(targetUrl);

  if (!proxyUrl) {
    return fetch(url, init);
  }

  if (process.env.NODE_USE_ENV_PROXY === '1') {
    return fetch(url, init);
  }

  return requestViaEnvProxySubprocess(url, init);
}

function getProxyUrl(targetUrl: URL): URL | undefined {
  const proxyValue = targetUrl.protocol === 'https:'
    ? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY
    : process.env.HTTP_PROXY ?? process.env.HTTPS_PROXY;
  if (!proxyValue) return undefined;

  if (isBypassedByNoProxy(targetUrl.hostname, targetUrl.port || defaultPort(targetUrl.protocol))) {
    return undefined;
  }

  return new URL(proxyValue);
}

function isBypassedByNoProxy(hostname: string, port: string): boolean {
  const noProxy = process.env.NO_PROXY ?? process.env.no_proxy;
  if (!noProxy) return false;

  for (const entry of noProxy.split(',').map(item => item.trim()).filter(Boolean)) {
    if (entry === '*') return true;

    const [hostPart, portPart] = entry.split(':');
    if (portPart && portPart !== port) continue;

    if (hostPart.startsWith('.')) {
      if (hostname.endsWith(hostPart)) return true;
      continue;
    }

    if (hostname === hostPart) return true;
  }

  return false;
}

function defaultPort(protocol: string): string {
  return protocol === 'https:' ? '443' : '80';
}

interface ResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

function headersToObject(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {};

  const normalized = new Headers(headers);
  const result: Record<string, string> = {};
  normalized.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

async function requestViaEnvProxySubprocess(url: string, init?: RequestInit): Promise<ResponseLike> {
  const payload = Buffer.from(JSON.stringify({
    url,
    init: normalizeRequestInit(init),
  }), 'utf8').toString('base64');

  const script = String.raw`
const payload = JSON.parse(Buffer.from(process.env.AIUSAGE_REQUEST_PAYLOAD, 'base64').toString('utf8'));
const response = await fetch(payload.url, payload.init);
const text = await response.text();
process.stdout.write(JSON.stringify({
  ok: response.ok,
  status: response.status,
  text,
}));
`;

  const { stdout } = await execFileAsync(
    process.execPath,
    ['--use-env-proxy', '--input-type=module', '-e', script],
    {
      env: {
        ...process.env,
        AIUSAGE_REQUEST_PAYLOAD: payload,
      },
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  const parsed = JSON.parse(stdout.trim()) as { ok: boolean; status: number; text: string };
  return {
    ok: parsed.ok,
    status: parsed.status,
    async text() {
      return parsed.text;
    },
  };
}

function normalizeRequestInit(init?: RequestInit): { method?: string; headers?: Record<string, string>; body?: string } {
  if (!init) return {};

  const next: { method?: string; headers?: Record<string, string>; body?: string } = {};
  if (init.method) next.method = init.method;
  if (init.headers) next.headers = headersToObject(init.headers);

  if (init.body != null) {
    if (typeof init.body === 'string') {
      next.body = init.body;
    } else if (init.body instanceof Buffer) {
      next.body = init.body.toString('utf8');
    } else {
      throw new Error('Unsupported request body type');
    }
  }

  return next;
}
