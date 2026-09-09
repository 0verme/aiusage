export type MemorySource = string;

export type MemoryEventType =
  | "implementation"
  | "debugging"
  | "research"
  | "decision"
  | "review"
  | "planning"
  | "testing"
  | "release"
  | "git"
  | "documentation";

export type MemoryDecisionStatus = "ACTIVE" | "SUPERSEDED" | "REVOKED";
export type MemoryNextActionStatus = "OPEN" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
export type MemoryProjectStatus = "ACTIVE" | "ARCHIVED" | "UNKNOWN";

export interface ProjectIdentityInput {
  cwd: string;
  repositoryRoot?: string;
  gitCommonDir?: string;
  remoteUrl?: string;
  projectName?: string;
  projectAlias?: string;
  metadata?: Record<string, unknown>;
}

export interface ProjectIdentity {
  projectId: string;
  projectKey: string;
  projectName: string;
  repoPath?: string;
  repoUrl?: string;
  worktreePath?: string;
  metadata?: Record<string, unknown>;
}

export interface MemorySourceReference {
  source: MemorySource;
  sourceSessionId: string;
  occurredAt: string;
  sourceRecordId?: string;
  sourcePath?: string;
  projectPath?: string;
  lineStart?: number;
  lineEnd?: number;
}

export interface NormalizedToolCall {
  id?: string;
  name: string;
  arguments?: Record<string, unknown>;
}

export interface NormalizedMessage {
  id?: string;
  role: "user" | "assistant";
  text?: string;
  timestamp: string;
  model?: string;
  toolCalls?: NormalizedToolCall[];
  sourceRef: MemorySourceReference;
}

export interface NormalizedSession {
  source: MemorySource;
  sessionId: string;
  project: ProjectIdentity;
  startedAt: string;
  endedAt: string;
  models: string[];
  toolNames: string[];
  messages: NormalizedMessage[];
  metadata?: Record<string, unknown>;
}

export interface MemoryProject {
  projectId: string;
  projectKey: string;
  projectName: string;
  repoPath?: string;
  repoUrl?: string;
  worktreePath?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  currentSummary?: string;
  status: MemoryProjectStatus;
  metadata?: Record<string, unknown>;
}

export interface MemoryWorkEvent {
  id: string;
  fingerprint: string;
  source: MemorySource;
  sourceSessionId: string;
  projectId: string;
  eventType: MemoryEventType;
  title: string;
  summary: string;
  occurredAt: string;
  sourceRef: MemorySourceReference;
  importance: number;
  confidence: number;
  category?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface MemoryDecision {
  id: string;
  fingerprint: string;
  projectId: string;
  topic: string;
  decision: string;
  reason: string;
  status: MemoryDecisionStatus;
  validFrom: string;
  validTo?: string;
  sourceEventId?: string;
  sourceRef: MemorySourceReference;
  confidence: number;
  createdAt: string;
}

export interface MemoryProjectState {
  projectId: string;
  summary: string;
  currentPhase: MemoryEventType;
  recentProgress: string[];
  blockers: string[];
  updatedAt: string;
  sourceEventId?: string;
  sourceRef?: MemorySourceReference;
}

export interface MemoryNextAction {
  id: string;
  fingerprint: string;
  projectId: string;
  content: string;
  status: MemoryNextActionStatus;
  sourceEventId?: string;
  sourceRef: MemorySourceReference;
  createdAt: string;
  completedAt?: string;
}

export interface MemoryExtractionResult {
  project: MemoryProject;
  workEvents: MemoryWorkEvent[];
  decisions: MemoryDecision[];
  projectState?: MemoryProjectState;
  nextActions: MemoryNextAction[];
}

export interface MemoryStoreSnapshot {
  schemaVersion: number;
  projects: MemoryProject[];
  workEvents: MemoryWorkEvent[];
  decisions: MemoryDecision[];
  projectStates: MemoryProjectState[];
  nextActions: MemoryNextAction[];
}

export interface MemoryProjectView {
  project: MemoryProject;
  state?: MemoryProjectState;
  recentDecisions: MemoryDecision[];
  recentEvents: MemoryWorkEvent[];
  nextActions: MemoryNextAction[];
}

export interface MemoryOverviewResponse {
  projects: MemoryProjectView[];
  totalProjects: number;
  totalEvents: number;
  totalDecisions: number;
  totalNextActions: number;
}

export interface MemorySearchQuery {
  projectId?: string;
  keyword?: string;
  eventType?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface MemoryIngestPayload {
  schemaVersion: string;
  generatedAt: string;
  projects: MemoryProject[];
  workEvents: MemoryWorkEvent[];
  decisions: MemoryDecision[];
  projectStates: MemoryProjectState[];
  nextActions: MemoryNextAction[];
}

export interface MemoryIngestRequest {
  siteId: string;
  schemaVersion: string;
  generatedAt: string;
  device: {
    deviceId: string;
    deviceAlias?: string;
    hostname: string;
    timezone: string;
    appVersion: string;
  };
  memory: MemoryIngestPayload;
}

export interface MemoryIngestResponse {
  projectsProcessed: number;
  eventsProcessed: number;
  decisionsProcessed: number;
  nextActionsProcessed: number;
}

export interface MemoryExtractor {
  extract(session: NormalizedSession): MemoryExtractionResult;
}
