import type { ProjectIdentity, ProjectIdentityInput } from "./types.js";

const HASH_OFFSET = 0xcbf29ce484222325n;
const HASH_PRIME = 0x100000001b3n;
const HASH_MASK = 0xffffffffffffffffn;

/** Normalize a repository URL without retaining credentials or a trailing .git. */
export function normalizeRepositoryUrl(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;

  const scp = raw.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
  if (scp && !raw.includes("://")) {
    return `${scp[1].toLowerCase()}/${normalizeRemotePath(scp[2])}`;
  }

  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    const path = normalizeRemotePath(parsed.pathname);
    return `${host}/${path}`;
  } catch {
    return normalizeRemotePath(raw.replace(/^git\+/, ""));
  }
}

/** Normalize paths for identity comparison across Windows and POSIX logs. */
export function normalizeProjectPath(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const replaced = raw.replaceAll("\\", "/");
  const prefix = replaced.match(/^[A-Za-z]:/i)?.[0]?.toLowerCase() ?? "";
  const hasRoot = replaced.startsWith("/") || Boolean(prefix);
  const body = prefix ? replaced.slice(2) : replaced;
  const segments: string[] = [];
  for (const segment of body.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === ".." && segments.length > 0 && segments.at(-1) !== "..") {
      segments.pop();
    } else if (segment !== "..") {
      segments.push(segment);
    }
  }
  const path = segments.join("/");
  if (prefix) return `${prefix}/${path}`.replace(/\/$/, "");
  if (hasRoot) return `/${path}`.replace(/\/$/, "") || "/";
  return path || ".";
}

export function projectIdForKey(projectKey: string): string {
  return `project_${stableHash(projectKey)}`;
}

/**
 * Resolve the stable project identity from deterministic local facts.
 * A remote URL wins, then the shared git directory (which is common to all
 * worktrees), then the repository root, and finally the raw cwd.
 */
export function resolveProjectIdentity(input: ProjectIdentityInput): ProjectIdentity {
  const cwd = input.cwd.trim() || "unknown";
  const normalizedRemote = normalizeRepositoryUrl(input.remoteUrl);
  const commonDir = normalizeProjectPath(input.gitCommonDir);
  const repositoryRoot = normalizeProjectPath(input.repositoryRoot);
  const commonRepositoryRoot = commonDir?.toLowerCase().endsWith('/.git')
    ? commonDir.slice(0, -5) || '/'
    : undefined;
  const canonicalRoot = commonRepositoryRoot ?? repositoryRoot;
  const normalizedCwd = normalizeProjectPath(cwd) ?? cwd;
  const projectKey = normalizedRemote
    ? `remote:${normalizedRemote}`
    : commonDir
      ? `git:${commonDir}`
      : canonicalRoot
        ? `path:${canonicalRoot}`
        : `path:${normalizedCwd}`;

  const fallbackName = basenameLike(canonicalRoot ?? normalizedCwd);
  const remoteName = normalizedRemote?.split("/").filter(Boolean).at(-1);
  const projectName =
    input.projectName?.trim() || input.projectAlias?.trim() || remoteName || fallbackName || "unknown";
  const metadata = {
    ...(input.metadata ?? {}),
    ...(input.projectAlias ? { displayAlias: input.projectAlias } : {}),
    ...(commonDir ? { gitCommonDir: commonDir } : {}),
  };
  const repoPath = canonicalRoot ?? normalizedCwd;
  const worktreePath =
    canonicalRoot && !samePath(canonicalRoot, normalizedCwd)
      ? cwd
      : undefined;

  return {
    projectId: projectIdForKey(projectKey),
    projectKey,
    projectName,
    repoPath,
    repoUrl: input.remoteUrl?.trim() || undefined,
    worktreePath,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

function normalizeRemotePath(value: string): string {
  return value
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replaceAll("\\", "/");
}

function basenameLike(value: string): string {
  const pieces = value.replaceAll("\\", "/").split("/").filter(Boolean);
  return pieces.at(-1) || "unknown";
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/\/+$/, "");
  return normalize(left) === normalize(right);
}

export function stableHash(value: string): string {
  let hash = HASH_OFFSET;
  for (const char of value) {
    hash ^= BigInt(char.codePointAt(0) ?? 0);
    hash = (hash * HASH_PRIME) & HASH_MASK;
  }
  return hash.toString(16).padStart(16, "0");
}
