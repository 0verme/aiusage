import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import {
  resolveProjectIdentity,
  type ProjectIdentity,
  type ProjectIdentityInput,
} from "@aiusage/memory-core";

const execFileAsync = promisify(execFile);

export interface MemoryProjectResolverOptions {
  projectAliases?: Record<string, string>;
  gitRunner?: (cwd: string, args: string[]) => Promise<string | undefined>;
}

/** Resolve Git facts once per session; failures fall back to deterministic cwd identity. */
export async function resolveMemoryProject(
  cwd: string,
  options: MemoryProjectResolverOptions = {},
): Promise<ProjectIdentity> {
  const trimmedCwd = cwd.trim() || "unknown";
  const alias = options.projectAliases?.[trimmedCwd] ?? options.projectAliases?.[basename(trimmedCwd)];
  const runGit = options.gitRunner ?? runGitCommand;

  try {
    const repositoryRoot = await runGit(trimmedCwd, ["rev-parse", "--show-toplevel"]);
    const commonDirValue = await runGit(trimmedCwd, ["rev-parse", "--git-common-dir"]);
    const remoteUrl = await runGit(trimmedCwd, ["remote", "get-url", "origin"]);
    const gitCommonDir = commonDirValue
      ? resolveGitCommonDir(trimmedCwd, repositoryRoot, commonDirValue)
      : undefined;
    const canonicalRoot = gitCommonDir && basename(gitCommonDir).toLowerCase() === ".git"
      ? dirname(gitCommonDir)
      : repositoryRoot;

    if (repositoryRoot || gitCommonDir || remoteUrl) {
      return resolveProjectIdentity({
        cwd: trimmedCwd,
        repositoryRoot: canonicalRoot,
        gitCommonDir,
        remoteUrl,
        projectAlias: alias,
        metadata: {
          ...(repositoryRoot ? { sessionRepositoryRoot: repositoryRoot } : {}),
        },
      });
    }
  } catch {
    // A session can point at a deleted directory or a non-Git workspace.
  }

  const fallback: ProjectIdentityInput = {
    cwd: trimmedCwd,
    projectAlias: alias,
  };
  return resolveProjectIdentity(fallback);
}

async function runGitCommand(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await execFileAsync("git", ["-C", cwd, ...args], {
      windowsHide: true,
      timeout: 2_000,
      maxBuffer: 64 * 1024,
    });
    const value = String(result.stdout).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function resolveGitCommonDir(cwd: string, repositoryRoot: string | undefined, value: string): string {
  if (isAbsolute(value)) return value;
  return resolve(repositoryRoot || cwd, value);
}
