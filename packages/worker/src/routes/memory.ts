import {
  decisionTopicKey,
  normalizeMemoryText,
  type MemoryDecision,
  type MemoryIngestRequest,
  type MemoryProject,
  type MemoryProjectState,
  type MemorySearchQuery,
  type MemoryWorkEvent,
  type MemoryNextAction,
} from '@aiusage/memory-core';
import { jsonNoStore, jsonError } from '../utils/response.js';
import { verifyDeviceToken } from '../utils/token.js';
import type { Env } from '../types.js';

export async function handleMemoryIngest(request: Request, env: Env): Promise<Response> {
  const token = await authorize(request, env);
  if (token instanceof Response) return token;

  const body = await request.json<MemoryIngestRequest>();
  if (body.siteId !== token.siteId) return jsonError(403, 'SITE_ID_MISMATCH', 'Site ID mismatch');
  if (body.device.deviceId !== token.deviceId) return jsonError(403, 'DEVICE_ID_MISMATCH', 'Device ID mismatch');
  if (!body.memory || body.memory.schemaVersion !== 'memory-v1') {
    return jsonError(400, 'INVALID_MEMORY_PAYLOAD', 'Unsupported Memory schema version');
  }

  const device = await env.DB.prepare(
    'SELECT status, token_version FROM devices WHERE device_id = ?',
  ).bind(token.deviceId).first<{ status: string; token_version: number }>();
  if (!device) return jsonError(401, 'INVALID_TOKEN', 'Device not found');
  if (device.status !== 'active') return jsonError(403, 'DEVICE_DISABLED', 'Device has been disabled');
  if (device.token_version !== token.tokenVersion) {
    return jsonError(401, 'TOKEN_VERSION_MISMATCH', 'Token version mismatch');
  }

  const now = new Date().toISOString();
  const memory = body.memory;
  for (const project of memory.projects) await upsertProject(env, token.deviceId, project, now);

  for (const event of memory.workEvents) {
    await insertEvent(env, token.deviceId, event, now);
  }

  const activeDecisions = await loadActiveDecisions(env, token.deviceId);
  for (const decision of memory.decisions) {
    await insertDecision(env, token.deviceId, decision, activeDecisions, now);
  }

  for (const state of memory.projectStates) await upsertState(env, token.deviceId, state);
  for (const action of memory.nextActions) await insertAction(env, token.deviceId, action);

  await env.DB.prepare(
    'UPDATE devices SET last_seen_at = ?, app_version = COALESCE(?, app_version), public_label = COALESCE(?, public_label) WHERE device_id = ?',
  ).bind(now, body.device.appVersion, body.device.deviceAlias ?? null, token.deviceId).run();

  return jsonNoStore({
    projectsProcessed: memory.projects.length,
    eventsProcessed: memory.workEvents.length,
    decisionsProcessed: memory.decisions.length,
    nextActionsProcessed: memory.nextActions.length,
  });
}

export async function handleMemoryOverview(url: URL, env: Env): Promise<Response> {
  if (!isMemoryPublic(env)) {
    return jsonError(404, 'MEMORY_NOT_ENABLED', 'Memory public read is disabled', true);
  }
  const query = parseMemoryQuery(url);
  const pattern = query.keyword ? `%${escapeLike(query.keyword)}%` : '';
  const projectId = query.projectId ?? '';
  const limit = query.limit ?? 50;
  const projectsResult = await env.DB.prepare(`
    SELECT p.*
    FROM memory_project p
    WHERE (? = '' OR p.project_id = ?)
      AND (
        ? = '' OR lower(p.project_name) LIKE ? ESCAPE '\\'
        OR lower(COALESCE(p.current_summary, '')) LIKE ? ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM memory_work_event e
          WHERE e.device_id = p.device_id AND e.project_id = p.project_id
            AND (lower(e.title) LIKE ? ESCAPE '\\' OR lower(e.summary) LIKE ? ESCAPE '\\')
        )
        OR EXISTS (
          SELECT 1 FROM memory_decision d
          WHERE d.device_id = p.device_id AND d.project_id = p.project_id
            AND (lower(d.topic) LIKE ? ESCAPE '\\' OR lower(d.decision) LIKE ? ESCAPE '\\')
        )
      )
    ORDER BY p.last_seen_at DESC
    LIMIT ?
  `).bind(
    projectId,
    projectId,
    pattern,
    pattern,
    pattern,
    pattern,
    pattern,
    pattern,
    pattern,
    limit,
  ).all<MemoryProjectRow>();

  const views = [];
  for (const row of projectsResult.results ?? []) {
    const project = toProject(row);
    const state = await env.DB.prepare(
      'SELECT * FROM memory_project_state WHERE device_id = ? AND project_id = ?',
    ).bind(row.device_id, row.project_id).first<MemoryStateRow>();
    const decisions = await env.DB.prepare(`
      SELECT * FROM memory_decision
      WHERE device_id = ? AND project_id = ?
        AND (? = '' OR valid_from >= ?)
        AND (? = '' OR valid_from <= ?)
      ORDER BY valid_from DESC LIMIT 20
    `).bind(row.device_id, row.project_id, query.from ?? '', query.from ?? '', query.to ?? '', `${query.to ?? ''}T23:59:59.999Z`).all<MemoryDecisionRow>();
    const events = await env.DB.prepare(`
      SELECT * FROM memory_work_event
      WHERE device_id = ? AND project_id = ?
        AND (? = '' OR event_type = ?)
        AND (? = '' OR occurred_at >= ?)
        AND (? = '' OR occurred_at <= ?)
      ORDER BY occurred_at DESC LIMIT 20
    `).bind(row.device_id, row.project_id, query.eventType ?? '', query.eventType ?? '', query.from ?? '', query.from ?? '', query.to ?? '', `${query.to ?? ''}T23:59:59.999Z`).all<MemoryEventRow>();
    const actions = await env.DB.prepare(`
      SELECT * FROM memory_next_action
      WHERE device_id = ? AND project_id = ?
        AND status NOT IN ('CANCELLED', 'COMPLETED')
      ORDER BY created_at DESC LIMIT 20
    `).bind(row.device_id, row.project_id).all<MemoryActionRow>();
    views.push({
      project,
      state: state ? toState(state) : undefined,
      recentDecisions: (decisions.results ?? []).map(toDecision),
      recentEvents: (events.results ?? []).map(toEvent),
      nextActions: (actions.results ?? []).map(toAction),
    });
  }

  return jsonNoStore({
    projects: views,
    totalProjects: views.length,
    totalEvents: views.reduce((sum, view) => sum + view.recentEvents.length, 0),
    totalDecisions: views.reduce((sum, view) => sum + view.recentDecisions.length, 0),
    totalNextActions: views.reduce((sum, view) => sum + view.nextActions.length, 0),
  }, true);
}

async function authorize(request: Request, env: Env): Promise<Authorization | Response> {
  const raw = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (!raw) return jsonError(401, 'INVALID_TOKEN', 'Missing authorization');
  const token = await verifyDeviceToken(raw, env.DEVICE_TOKEN_SECRET);
  if (!token) return jsonError(401, 'INVALID_TOKEN', 'Invalid device token');
  return token;
}

async function upsertProject(env: Env, deviceId: string, project: MemoryProject, now: string): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO memory_project
      (device_id, project_id, project_key, project_name, repo_path, repo_url,
       first_seen_at, last_seen_at, current_summary, status, metadata_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (device_id, project_id) DO UPDATE SET
      project_key = excluded.project_key,
      project_name = excluded.project_name,
      repo_path = COALESCE(excluded.repo_path, memory_project.repo_path),
      repo_url = COALESCE(excluded.repo_url, memory_project.repo_url),
      first_seen_at = MIN(memory_project.first_seen_at, excluded.first_seen_at),
      last_seen_at = MAX(memory_project.last_seen_at, excluded.last_seen_at),
      current_summary = COALESCE(excluded.current_summary, memory_project.current_summary),
      status = excluded.status,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at
  `).bind(
    deviceId,
    project.projectId,
    project.projectKey,
    project.projectName,
    project.repoPath ?? null,
    project.repoUrl ?? null,
    project.firstSeenAt,
    project.lastSeenAt,
    project.currentSummary ?? null,
    project.status,
    json(project.metadata),
    now,
    now,
  ).run();
}

async function insertEvent(env: Env, deviceId: string, event: MemoryWorkEvent, now: string): Promise<void> {
  await env.DB.prepare(`
    INSERT OR IGNORE INTO memory_work_event
      (device_id, id, fingerprint, source, source_session_id, project_id,
       event_type, title, summary, occurred_at, source_ref_json, importance,
       confidence, category, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    deviceId,
    event.id,
    event.fingerprint,
    event.source,
    event.sourceSessionId,
    event.projectId,
    event.eventType,
    event.title,
    event.summary,
    event.occurredAt,
    json(event.sourceRef),
    event.importance,
    event.confidence,
    event.category ?? null,
    json(event.metadata),
    event.createdAt || now,
  ).run();
}

async function loadActiveDecisions(env: Env, deviceId: string): Promise<MemoryDecisionRow[]> {
  const result = await env.DB.prepare(
    "SELECT * FROM memory_decision WHERE device_id = ? AND status = 'ACTIVE'",
  ).bind(deviceId).all<MemoryDecisionRow>();
  return result.results ?? [];
}

async function insertDecision(
  env: Env,
  deviceId: string,
  decision: MemoryDecision,
  activeDecisions: MemoryDecisionRow[],
  now: string,
): Promise<void> {
  const existing = await env.DB.prepare(
    'SELECT id FROM memory_decision WHERE device_id = ? AND fingerprint = ?',
  ).bind(deviceId, decision.fingerprint).first<{ id: string }>();
  if (existing) return;

  const topicKey = decisionTopicKey(decision.topic);
  if (decision.status === 'ACTIVE' && activeDecisions.some(
    (previous) =>
      previous.project_id === decision.projectId &&
      decisionTopicKey(previous.topic) === topicKey &&
      normalizeMemoryText(previous.decision) === normalizeMemoryText(decision.decision),
  )) return;

  const active = activeDecisions.filter(
    (previous) =>
      previous.project_id === decision.projectId &&
      decisionTopicKey(previous.topic) === topicKey &&
      normalizeMemoryText(previous.decision) !== normalizeMemoryText(decision.decision),
  );
  const newer = active
    .filter((previous) => previous.valid_from > decision.validFrom)
    .sort((left, right) => right.valid_from.localeCompare(left.valid_from))[0];
  const nextDecision: MemoryDecision = newer
    ? { ...decision, status: 'SUPERSEDED', validTo: newer.valid_from }
    : decision;

  if (!newer) {
    for (const previous of active) {
      await env.DB.prepare(
        "UPDATE memory_decision SET status = 'SUPERSEDED', valid_to = ? WHERE device_id = ? AND id = ? AND status = 'ACTIVE'",
      ).bind(decision.validFrom, deviceId, previous.id).run();
      previous.status = 'SUPERSEDED';
      previous.valid_to = decision.validFrom;
    }
  }

  await env.DB.prepare(`
    INSERT OR IGNORE INTO memory_decision
      (device_id, id, fingerprint, project_id, topic, decision, reason,
       status, valid_from, valid_to, source_event_id, source_ref_json,
       confidence, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    deviceId,
    nextDecision.id,
    nextDecision.fingerprint,
    nextDecision.projectId,
    nextDecision.topic,
    nextDecision.decision,
    nextDecision.reason ?? null,
    nextDecision.status,
    nextDecision.validFrom,
    nextDecision.validTo ?? null,
    nextDecision.sourceEventId ?? null,
    json(nextDecision.sourceRef),
    nextDecision.confidence,
    nextDecision.createdAt || now,
  ).run();
  if (nextDecision.status === 'ACTIVE') activeDecisions.push(rowFromDecision(nextDecision, deviceId));
}

async function upsertState(env: Env, deviceId: string, state: MemoryProjectState): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO memory_project_state
      (device_id, project_id, summary, current_phase, recent_progress_json,
       blockers_json, updated_at, source_event_id, source_ref_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (device_id, project_id) DO UPDATE SET
      summary = excluded.summary,
      current_phase = excluded.current_phase,
      recent_progress_json = excluded.recent_progress_json,
      blockers_json = excluded.blockers_json,
      updated_at = excluded.updated_at,
      source_event_id = excluded.source_event_id,
      source_ref_json = excluded.source_ref_json
    WHERE excluded.updated_at >= memory_project_state.updated_at
  `).bind(
    deviceId,
    state.projectId,
    state.summary,
    state.currentPhase,
    JSON.stringify(state.recentProgress),
    JSON.stringify(state.blockers),
    state.updatedAt,
    state.sourceEventId ?? null,
    state.sourceRef ? json(state.sourceRef) : null,
  ).run();
}

async function insertAction(env: Env, deviceId: string, action: MemoryNextAction): Promise<void> {
  await env.DB.prepare(`
    INSERT OR IGNORE INTO memory_next_action
      (device_id, id, fingerprint, project_id, content, status,
       source_event_id, source_ref_json, created_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    deviceId,
    action.id,
    action.fingerprint,
    action.projectId,
    action.content,
    action.status,
    action.sourceEventId ?? null,
    json(action.sourceRef),
    action.createdAt,
    action.completedAt ?? null,
  ).run();
}

function parseMemoryQuery(url: URL): MemorySearchQuery {
  const limit = Number(url.searchParams.get('limit') ?? 50);
  return {
    projectId: url.searchParams.get('project') || undefined,
    keyword: url.searchParams.get('q')?.trim().toLocaleLowerCase() || undefined,
    eventType: url.searchParams.get('event') || undefined,
    from: url.searchParams.get('from') || undefined,
    to: url.searchParams.get('to') || undefined,
    limit: Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), 100)) : 50,
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function json(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

interface Authorization {
  siteId: string;
  deviceId: string;
  tokenVersion: number;
  issuedAt: string;
}

interface MemoryProjectRow {
  device_id: string;
  project_id: string;
  project_key: string;
  project_name: string;
  repo_path: string | null;
  repo_url: string | null;
  first_seen_at: string;
  last_seen_at: string;
  current_summary: string | null;
  status: string;
  metadata_json: string | null;
}

interface MemoryEventRow {
  device_id: string;
  id: string;
  fingerprint: string;
  source: string;
  source_session_id: string;
  project_id: string;
  event_type: string;
  title: string;
  summary: string;
  occurred_at: string;
  source_ref_json: string;
  importance: number;
  confidence: number;
  category: string | null;
  metadata_json: string | null;
  created_at: string;
}

interface MemoryDecisionRow {
  device_id: string;
  id: string;
  fingerprint: string;
  project_id: string;
  topic: string;
  decision: string;
  reason: string | null;
  status: string;
  valid_from: string;
  valid_to: string | null;
  source_event_id: string | null;
  source_ref_json: string;
  confidence: number;
  created_at: string;
}

interface MemoryStateRow {
  device_id: string;
  project_id: string;
  summary: string;
  current_phase: string;
  recent_progress_json: string;
  blockers_json: string;
  updated_at: string;
  source_event_id: string | null;
  source_ref_json: string | null;
}

interface MemoryActionRow {
  device_id: string;
  id: string;
  fingerprint: string;
  project_id: string;
  content: string;
  status: string;
  source_event_id: string | null;
  source_ref_json: string;
  created_at: string;
  completed_at: string | null;
}

function toProject(row: MemoryProjectRow): MemoryProject {
  return {
    projectId: row.project_id,
    projectKey: row.project_key,
    projectName: row.project_name,
    // Public Memory must not disclose local paths or private repository URLs.
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    ...(row.current_summary ? { currentSummary: row.current_summary } : {}),
    status: row.status as MemoryProject['status'],
    metadata: publicMetadata(parseJson<Record<string, unknown>>(row.metadata_json)),
  };
}

function toEvent(row: MemoryEventRow): MemoryWorkEvent {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    source: row.source,
    sourceSessionId: row.source_session_id,
    projectId: row.project_id,
    eventType: row.event_type as MemoryWorkEvent['eventType'],
    title: row.title,
    summary: row.summary,
    occurredAt: row.occurred_at,
    sourceRef: publicSourceRef(parseJson(row.source_ref_json) ?? {
      source: row.source,
      sourceSessionId: row.source_session_id,
      occurredAt: row.occurred_at,
    }),
    importance: row.importance,
    confidence: row.confidence,
    ...(row.category ? { category: row.category } : {}),
    metadata: publicMetadata(parseJson<Record<string, unknown>>(row.metadata_json)),
    createdAt: row.created_at,
  };
}

function toDecision(row: MemoryDecisionRow): MemoryDecision {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    projectId: row.project_id,
    topic: row.topic,
    decision: row.decision,
    reason: row.reason ?? '',
    status: row.status as MemoryDecision['status'],
    validFrom: row.valid_from,
    ...(row.valid_to ? { validTo: row.valid_to } : {}),
    ...(row.source_event_id ? { sourceEventId: row.source_event_id } : {}),
    sourceRef: publicSourceRef(parseJson(row.source_ref_json)),
    confidence: row.confidence,
    createdAt: row.created_at,
  };
}

function toState(row: MemoryStateRow): MemoryProjectState {
  return {
    projectId: row.project_id,
    summary: row.summary,
    currentPhase: row.current_phase as MemoryProjectState['currentPhase'],
    recentProgress: parseJson<string[]>(row.recent_progress_json) ?? [],
    blockers: parseJson<string[]>(row.blockers_json) ?? [],
    updatedAt: row.updated_at,
    ...(row.source_event_id ? { sourceEventId: row.source_event_id } : {}),
    sourceRef: row.source_ref_json
      ? publicSourceRef(parseJson(row.source_ref_json))
      : undefined,
  };
}

function toAction(row: MemoryActionRow): MemoryNextAction {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    projectId: row.project_id,
    content: row.content,
    status: row.status as MemoryNextAction['status'],
    ...(row.source_event_id ? { sourceEventId: row.source_event_id } : {}),
    sourceRef: publicSourceRef(parseJson(row.source_ref_json)),
    createdAt: row.created_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

function rowFromDecision(decision: MemoryDecision, deviceId: string): MemoryDecisionRow {
  return {
    device_id: deviceId,
    id: decision.id,
    fingerprint: decision.fingerprint,
    project_id: decision.projectId,
    topic: decision.topic,
    decision: decision.decision,
    reason: decision.reason ?? null,
    status: decision.status,
    valid_from: decision.validFrom,
    valid_to: decision.validTo ?? null,
    source_event_id: decision.sourceEventId ?? null,
    source_ref_json: JSON.stringify(decision.sourceRef),
    confidence: decision.confidence,
    created_at: decision.createdAt,
  };
}

function parseJson<T>(value: string | null | undefined): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function publicSourceRef(value: unknown) {
  const sourceRef = isRecord(value) ? value : {};
  return {
    source: String(sourceRef.source ?? 'unknown'),
    sourceSessionId: String(sourceRef.sourceSessionId ?? 'unknown'),
    occurredAt: String(sourceRef.occurredAt ?? ''),
    ...(typeof sourceRef.sourceRecordId === 'string'
      ? { sourceRecordId: sourceRef.sourceRecordId }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function publicMetadata(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !/(path|cwd|repo|command|input)/i.test(key)),
  );
}

function isMemoryPublic(env: Env): boolean {
  return String((env as Env & { MEMORY_PUBLIC?: string }).MEMORY_PUBLIC).toLowerCase() === 'true';
}
