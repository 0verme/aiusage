import { jsonNoStore, jsonError } from '../utils/response.js';
import { signDeviceToken } from '../utils/token.js';
import type { Env } from '../types.js';

interface EnrollBody {
  siteId: string;
  deviceId: string;
  deviceAlias?: string;
  hostname: string;
  timezone: string;
  appVersion: string;
}

export async function handleEnroll(request: Request, env: Env): Promise<Response> {
  // 校验 ENROLL_TOKEN
  const auth = request.headers.get('Authorization');
  if (!auth || auth !== `Bearer ${env.ENROLL_TOKEN}`) {
    return jsonError(401, 'INVALID_TOKEN', 'Invalid enroll token');
  }

  const body = await request.json<EnrollBody>();

  if (body.siteId !== env.SITE_ID) {
    return jsonError(403, 'SITE_ID_MISMATCH', 'Site ID does not match');
  }

  if (!body.deviceId || !body.hostname || !body.timezone) {
    return jsonError(400, 'INVALID_PAYLOAD', 'Missing required fields: deviceId, hostname, timezone');
  }

  // 检查设备是否已存在
  const existing = await env.DB.prepare('SELECT device_id, token_version, status FROM devices WHERE device_id = ?')
    .bind(body.deviceId)
    .first<{ device_id: string; token_version: number; status: string }>();

  let tokenVersion = 1;
  const now = new Date().toISOString();

  if (existing) {
    if (existing.status === 'disabled') {
      return jsonError(403, 'DEVICE_DISABLED', 'Device has been disabled');
    }
    // 已存在：递增 token_version 重新签发
    tokenVersion = existing.token_version + 1;
    await env.DB.prepare(
      'UPDATE devices SET hostname = ?, public_label = ?, timezone = ?, token_version = ?, last_seen_at = ?, app_version = ? WHERE device_id = ?',
    )
      .bind(body.hostname, body.deviceAlias ?? null, body.timezone, tokenVersion, now, body.appVersion, body.deviceId)
      .run();
  } else {
    // 检查设备数上限
    const maxDevices = parseInt(env.MAX_DEVICES, 10) || 10;
    const { count } = await env.DB.prepare('SELECT COUNT(*) as count FROM devices')
      .first<{ count: number }>() ?? { count: 0 };
    if (count >= maxDevices) {
      return jsonError(403, 'MAX_DEVICES_REACHED', `Maximum of ${maxDevices} devices allowed`);
    }
    // 新设备
    await env.DB.prepare(
      'INSERT INTO devices (device_id, hostname, public_label, timezone, status, token_version, first_seen_at, last_seen_at, app_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(body.deviceId, body.hostname, body.deviceAlias ?? null, body.timezone, 'active', tokenVersion, now, now, body.appVersion)
      .run();
  }

  const deviceToken = await signDeviceToken(
    { siteId: env.SITE_ID, deviceId: body.deviceId, tokenVersion, issuedAt: now },
    env.DEVICE_TOKEN_SECRET,
  );

  return jsonNoStore({
    siteId: env.SITE_ID,
    deviceId: body.deviceId,
    deviceToken,
    issuedAt: now,
  });
}
