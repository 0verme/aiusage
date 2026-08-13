import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface ClaudeProjectDirOptions {
  /** An already-resolved projects directory used by scanner unit tests and callers. */
  explicitProjectsDir?: string;
  /** Already-resolved project directories supplied by higher-level configuration. */
  configuredProjectsDirs?: readonly string[];
  homeDir?: string;
  configDirEnv?: string;
}

/**
 * Resolve every Claude Code projects directory that may contain local history.
 *
 * CLAUDE_CONFIG_DIR is additive: moving Claude's active config must not hide
 * sessions left in the default locations. Explicit scanner/config arguments
 * keep their existing override semantics.
 */
export function getClaudeProjectDirs(options: ClaudeProjectDirOptions = {}): string[] {
  if (options.explicitProjectsDir) return [options.explicitProjectsDir];
  if (options.configuredProjectsDirs?.length) return uniquePaths(options.configuredProjectsDirs);

  const home = options.homeDir ?? homedir();
  const configRoots = (options.configDirEnv ?? process.env.CLAUDE_CONFIG_DIR ?? '')
    .split(',')
    .map(path => path.trim())
    .filter(Boolean);

  return uniquePaths([
    ...configRoots.map(root => join(root, 'projects')),
    join(home, '.config', 'claude', 'projects'),
    join(home, '.claude', 'projects'),
  ]);
}

function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const key = process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(path);
  }
  return result;
}
