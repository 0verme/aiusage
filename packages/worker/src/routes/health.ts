import { SERVICE_NAME, SCHEMA_VERSION } from '@aiusage/shared';
import { jsonNoStore } from '../utils/response.js';
import type { Env } from '../types.js';

export function handleHealth(env: Env): Response {
  return jsonNoStore({
    siteId: env.SITE_ID,
    service: SERVICE_NAME,
    schemaVersion: SCHEMA_VERSION,
    time: new Date().toISOString(),
  });
}
