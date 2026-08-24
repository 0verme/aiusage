import { describe, expect, it } from 'vitest';
import {
  canonicalProviderSqlExpression,
  canonicalizeProvider,
  inferProviderFromModel,
  normalizeProviderId,
} from '../provider.js';

describe('inferProviderFromModel', () => {
  it.each([
    ['claude-sonnet-4-6', 'anthropic'],
    ['opus-4-7-fast', 'anthropic'],
    ['gpt-5.6-sol-priority', 'openai'],
    ['o3-mini', 'openai'],
    ['gemini-3.1-pro-preview', 'google'],
    ['qwen3-coder-plus', 'alibaba'],
    ['deepseek-v4-flash[1M]', 'deepseek'],
    ['glm-4.7-flash', 'zhipu'],
    ['codegeex-4', 'zhipu'],
    ['kimi-k3', 'moonshot'],
    ['grok-4.5', 'xai'],
    ['openai/gpt-5.6', 'openai'],
  ])('%s -> %s', (model, provider) => {
    expect(inferProviderFromModel(model, 'fallback')).toBe(provider);
  });

  it('keeps fallback when the model is unknown or empty', () => {
    expect(inferProviderFromModel('custom-model', 'fallback')).toBe('fallback');
    expect(inferProviderFromModel('', 'fallback')).toBe('fallback');
    expect(inferProviderFromModel(null, 'fallback')).toBe('fallback');
  });
});

describe('canonicalizeProvider', () => {
  it.each([
    ['openai', 'codex', 'gpt-5.6-sol', 'openai'],
    ['openai-codex', 'codex', 'gpt-5.6-sol', 'openai'],
    ['openai_codex', 'codex', 'GPT-5.6-sol-priority', 'openai'],
    ['opencode', 'opencode', 'gpt-5.6-sol', 'openai'],
    ['opencode', 'opencode', 'claude-sonnet-4-6', 'anthropic'],
    ['opencode', 'opencode', 'deepseek-v4-flash', 'deepseek'],
    ['opencode', 'opencode', 'gemini-3.1-pro', 'google'],
    ['opencode', 'opencode', 'grok-4.5', 'xai'],
    ['opencode-go', 'opencode', 'deepseek-v4-flash', 'deepseek'],
    ['custom', 'claude-code', 'deepseek-v4-flash', 'deepseek'],
  ])('%s + %s + %s -> %s', (provider, product, model, expected) => {
    expect(canonicalizeProvider({ provider, product, model })).toBe(expected);
  });

  it('normalizes case, preserves product, and handles safe fallbacks', () => {
    expect(canonicalizeProvider({ provider: ' OpenAI ', product: 'codex', model: 'GPT-5.6' })).toBe('openai');
    expect(canonicalizeProvider({ provider: 'OpenCode-Go', product: 'opencode', model: 'unknown-model' })).toBe('opencode-go');
    expect(canonicalizeProvider({ provider: 'unknown-provider', product: 'opencode', model: 'unknown-model' })).toBe('unknown-provider');
    expect(canonicalizeProvider({ provider: '', product: 'opencode', model: '' })).toBe('unknown');
    expect(canonicalizeProvider({ provider: 'unknown-provider', product: 'opencode', model: 'deepseek-v4-flash[1M]' })).toBe('deepseek');
  });

  it('normalizes provider namespaces and historical aliases', () => {
    expect(normalizeProviderId('openai-codex/official')).toBe('openai');
    expect(normalizeProviderId('x_ai')).toBe('xai');
    expect(normalizeProviderId('<unknown>')).toBe('unknown');
  });
});

describe('canonicalProviderSqlExpression', () => {
  it('contains the same alias and model rules used by the runtime canonicalizer', () => {
    const expression = canonicalProviderSqlExpression('b.provider', 'b.model');
    expect(expression).toContain("'openai-codex'");
    expect(expression).toContain("'openai_codex'");
    expect(expression).toContain("'deepseek'");
    expect(expression).toContain('b.model');
  });
});
