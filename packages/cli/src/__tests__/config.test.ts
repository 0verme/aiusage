import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const mockHomedir = vi.fn();

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => mockHomedir(),
  };
});

let homeDir: string;

beforeEach(async () => {
  homeDir = join(tmpdir(), `aiusage-config-${Date.now()}`);
  mockHomedir.mockReturnValue(homeDir);
  await mkdir(join(homeDir, '.aiusage'), { recursive: true });
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

describe('readConfig', () => {
  it('reads UTF-8 BOM prefixed config files', async () => {
    await writeFile(
      join(homeDir, '.aiusage', 'config.json'),
      '\uFEFF{"deviceId":"dev-1","targets":[{"name":"default","apiBaseUrl":"https://example.com"}]}',
      'utf8',
    );

    const { readConfig, getConfigPath } = await import('../config.js');
    const config = await readConfig();

    expect(getConfigPath()).toBe(join(homeDir, '.aiusage', 'config.json'));
    expect(config.deviceId).toBe('dev-1');
    expect(config.targets).toHaveLength(1);
    expect(config.targets?.[0]).toMatchObject({
      name: 'default',
      apiBaseUrl: 'https://example.com',
    });
  });
});

describe('setConfigValue', () => {
  it('sets and clears additional OpenCode database paths', async () => {
    const { setConfigValue } = await import('../config.js');
    const configured = setConfigValue({}, 'scanner.opencodeDbPaths', [
      '/data/opencode-next.db',
      '/data/opencode-stable.db',
      '/data/opencode-next.db',
    ]);
    expect(configured.scanner?.opencodeDbPaths).toEqual([
      '/data/opencode-next.db',
      '/data/opencode-stable.db',
    ]);

    const cleared = setConfigValue(configured, 'scanner.opencodeDbPaths', ['default']);
    expect(cleared.scanner?.opencodeDbPaths).toBeUndefined();
  });
});
