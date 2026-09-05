import { describe, expect, it } from 'vitest';
import {
  auditModelAliases,
  canonicalizeModel,
  displayModelName,
  modelProviderHint,
  normalizeModelKey,
} from '../model.js';
import { resolveModelIdentity } from '../pricing/identity.js';

describe('model canonicalization', () => {
  it('applies only safe syntax normalization for case and separators', () => {
    expect(canonicalizeModel('GLM-5.3-Flash')).toBe('glm-5.3-flash');
    expect(canonicalizeModel('glm_5.3_flash')).toBe('glm-5.3-flash');
    expect(normalizeModelKey('  GLM--5.3___Flash  ').model).toBe('glm-5.3-flash');
  });

  it('uses explicit aliases for dated snapshots', () => {
    expect(canonicalizeModel('DeepSeek-V4-Flash-0731')).toBe('deepseek-v4-flash');
    expect(canonicalizeModel('claude-opus-4-5-20251101')).toBe('claude-opus-4.5');
    expect(canonicalizeModel('deepseek-v4-flash')).toBe('deepseek-v4-flash');
  });

  it('splits known provider namespaces without losing raw identity', () => {
    expect(canonicalizeModel('anthropic/claude-opus-4.8-coding')).toBe('claude-opus-4.8-coding');
    expect(modelProviderHint('anthropic/claude-opus-4.8-coding')).toEqual({
      id: 'anthropic',
      label: 'Anthropic',
      prefix: 'anthropic',
    });

    expect(canonicalizeModel('zai-org/glm-5.3')).toBe('glm-5.3');
    expect(modelProviderHint('zai-org/glm-5.3')).toEqual({
      id: 'zhipu',
      label: 'Z.AI',
      prefix: 'zai-org',
    });
  });

  it('keeps distinct model capabilities and versions separate', () => {
    expect(canonicalizeModel('claude-sonnet-4')).not.toBe(canonicalizeModel('claude-sonnet-4.5'));
    expect(canonicalizeModel('gpt-5.4')).not.toBe(canonicalizeModel('gpt-5.4-mini'));
    expect(canonicalizeModel('glm-5.3')).not.toBe(canonicalizeModel('glm-5.3-flash'));
    expect(canonicalizeModel('deepseek-v4')).not.toBe(canonicalizeModel('deepseek-v4-flash'));
  });

  it('does not delete an unknown provider namespace', () => {
    expect(canonicalizeModel('unknown-provider/foo-model')).toBe('unknown-provider/foo-model');
    expect(modelProviderHint('unknown-provider/foo-model')).toBeUndefined();
  });

  it('formats canonical IDs with provider brand conventions', () => {
    expect(displayModelName('glm-5.3-flash')).toBe('GLM-5.3 Flash');
    expect(displayModelName('deepseek-v4-flash')).toBe('DeepSeek V4 Flash');
    expect(displayModelName('claude-opus-4.8-coding')).toBe('Claude Opus 4.8 Coding');
    expect(displayModelName('gpt-5.4-mini')).toBe('GPT-5.4 Mini');
    expect(displayModelName('glm-5.3')).toBe('GLM-5.3');
  });

  it('reports explicit aliases and leaves suspicious aliases for review', () => {
    const report = auditModelAliases([
      'DeepSeek-V4-Flash-0731',
      'deepseek-v4-flash',
      'gpt-5-6',
      'gpt_5_6',
      'gpt-5-6-20260101',
    ]);

    expect(auditModelAliases(['deepseek-v4-flash-0731']).knownAliases).toEqual([
      expect.objectContaining({
        canonicalModel: 'deepseek-v4-flash',
        explicitAliases: ['deepseek-v4-flash-0731'],
      }),
    ]);
    expect(report.knownAliases).toEqual([
      expect.objectContaining({
        canonicalModel: 'deepseek-v4-flash',
        explicitAliases: ['deepseek-v4-flash-0731'],
      }),
    ]);
    expect(report.safeVariants).toEqual([
      expect.objectContaining({
        canonicalModel: 'gpt-5-6',
        rawModels: ['gpt_5_6', 'gpt-5-6'],
      }),
    ]);
    expect(report.remainingUnknownAliases).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rawModel: 'gpt-5-6-20260101',
        reason: 'dated-suffix',
      }),
      expect.objectContaining({
        rawModel: 'gpt-5-6',
        reason: 'version-separator',
      }),
    ]));
  });

  it('keeps pricing model key independent from canonical aggregation ID', () => {
    const identity = resolveModelIdentity('DeepSeek-V4-Flash-0731');
    expect(identity.rawModel).toBe('DeepSeek-V4-Flash-0731');
    expect(identity.pricingModelKey).toBe('deepseek-v4-flash-0731');
    expect(identity.canonicalModel).toBe('deepseek-v4-flash');
    expect(identity.displayName).toBe('DeepSeek V4 Flash');
  });
});
