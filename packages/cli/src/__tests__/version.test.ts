import { describe, expect, it } from 'vitest';
import { formatBuildInfo, getBuildInfo, getVersion } from '../version.js';

describe('getVersion', () => {
  it('返回 packages/cli/package.json 里的版本号', () => {
    expect(getVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('getBuildInfo', () => {
  it('从源码运行时没有 dist/build-info.json，标记为 missing 而不是臆测提交', () => {
    expect(getBuildInfo().missing).toBe(true);
  });
});

describe('formatBuildInfo', () => {
  it('缺少构建信息时明确说明，不伪装成已知版本', () => {
    expect(formatBuildInfo({ missing: true })).toContain('build-info.json not found');
    expect(formatBuildInfo({ missing: true })).toContain('unknown');
  });

  it('展示版本、短提交号与构建时间', () => {
    const text = formatBuildInfo({
      version: '1.1.0',
      commit: '0123456789abcdef0123',
      commitDate: '2026-10-14T00:00:00+08:00',
      dirty: false,
      builtAt: '2026-10-14T12:00:00.000Z',
    });

    expect(text).toContain('1.1.0');
    expect(text).toContain('0123456789ab');
    expect(text).toContain('2026-10-14T12:00:00.000Z');
    expect(text).not.toContain('+dirty');
  });

  it('脏工作区构建带 +dirty，脏状态未知时如实标注', () => {
    expect(formatBuildInfo({ version: '1.1.0', commit: 'abcdef123456', dirty: true, builtAt: 'x' }))
      .toContain('+dirty');
    expect(formatBuildInfo({ version: '1.1.0', commit: 'abcdef123456', dirty: null, builtAt: 'x' }))
      .toContain('clean state unknown');
  });

  it('提交号缺失或字面量 unknown 时显示 unknown', () => {
    expect(formatBuildInfo({ version: '1.1.0', commit: 'unknown', dirty: false, builtAt: 'x' })).toContain('unknown');
    expect(formatBuildInfo({ version: '1.1.0', builtAt: 'x' })).toContain('unknown');
  });

  it('默认参数走真实产物信息', () => {
    expect(typeof formatBuildInfo()).toBe('string');
  });
});
