import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { getClaudeProjectDirs } from '../claude-paths.js';

describe('getClaudeProjectDirs', () => {
  it('combines CLAUDE_CONFIG_DIR roots with both default locations', () => {
    const home = join('C:', 'Users', 'test');
    const dirs = getClaudeProjectDirs({
      homeDir: home,
      configDirEnv: 'D:\\claude-config,C:\\portable-claude',
    });

    expect(dirs).toEqual([
      join('D:\\claude-config', 'projects'),
      join('C:\\portable-claude', 'projects'),
      join(home, '.config', 'claude', 'projects'),
      join(home, '.claude', 'projects'),
    ]);
  });

  it('deduplicates a custom root that points at the default config directory', () => {
    const home = join('C:', 'Users', 'test');
    const defaultConfig = join(home, '.claude');

    expect(getClaudeProjectDirs({ homeDir: home, configDirEnv: defaultConfig })).toEqual([
      join(defaultConfig, 'projects'),
      join(home, '.config', 'claude', 'projects'),
    ]);
  });

  it('keeps an explicit projects directory isolated', () => {
    expect(getClaudeProjectDirs({
      explicitProjectsDir: 'X:\\fixture\\projects',
      homeDir: 'C:\\Users\\test',
      configDirEnv: 'D:\\claude-config',
    })).toEqual(['X:\\fixture\\projects']);
  });
});
