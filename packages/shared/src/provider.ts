/**
 * Provider 统计维度的统一归一化规则。
 *
 * 这里的 provider 表示模型厂商；调用客户端、gateway provider ID 和历史
 * alias 只能作为推断输入，不能直接成为最终统计维度。定价仍由
 * pricing/identity.ts 单独处理，以保留 custom / opencode-go 等历史定价入口。
 */

import { normalizeModelKey } from './model.js';

export interface ProviderCanonicalizationInput {
  provider?: string | null;
  product?: string | null;
  model?: string | null;
}

/** OpenCode 等客户端可能上报的 provider alias。 */
export const PROVIDER_ALIASES = {
  openai_codex: 'openai',
  'openai-codex': 'openai',
  github_copilot: 'github',
  'github-copilot': 'github',
  x_ai: 'xai',
  z_ai: 'zai',
  moonshotai: 'moonshot',
  meta: 'meta_llama',
  azure: 'azure_ai',
  vertex: 'anthropic',
  vertex_ai: 'anthropic',
  together: 'together_ai',
  fireworks: 'fireworks_ai',
  gemini: 'google',
  minimaxai: 'minimax',
  minimax_ai: 'minimax',
  mistral: 'mistralai',
  zai: 'zhipu',
  'zai-org': 'zhipu',
  zhipuai: 'zhipu',
} as const;

/**
 * 模型名前缀到真实模型厂商的唯一映射。
 * JS 推断与 Worker 历史 SQL 聚合共用这份规则，避免各层维护不同表。
 */
export const MODEL_PROVIDER_RULES = [
  { provider: 'anthropic', prefixes: ['claude', 'opus', 'sonnet', 'haiku'] },
  { provider: 'openai', prefixes: ['gpt', 'chatgpt', 'codex', 'o1', 'o3', 'o4'] },
  { provider: 'google', prefixes: ['gemini'] },
  { provider: 'alibaba', prefixes: ['qwen'] },
  { provider: 'deepseek', prefixes: ['deepseek'] },
  { provider: 'zhipu', prefixes: ['glm', 'codegeex'] },
  { provider: 'moonshot', prefixes: ['kimi', 'moonshot'] },
  { provider: 'xai', prefixes: ['grok'] },
] as const;

/**
 * 根据模型名推断真实模型厂商；无法识别时返回 fallback。
 * 支持 service tier、context window 和 provider/model 形式的模型名。
 */
export function inferProviderFromModel(model: string | null | undefined, fallback: string): string {
  let value = normalizeModelKey(model).model;
  // Provider inference may inspect an unknown gateway namespace, while the
  // canonical model identity intentionally keeps that namespace intact.
  const slashIndex = value.lastIndexOf('/');
  if (slashIndex >= 0) value = value.slice(slashIndex + 1);
  value = value
    .replace(/\[\d+[a-zA-Z]*\]$/, '')
    .replace(/-(?:fast|priority)$/, '');

  for (const rule of MODEL_PROVIDER_RULES) {
    if (rule.prefixes.some(prefix => modelStartsWith(value, prefix))) {
      return rule.provider;
    }
  }
  return fallback;
}

/**
 * 归一化 provider 文字但不根据 model 推断。适用于没有 model 的 activity 记录。
 */
export function normalizeProviderId(provider?: string | null): string {
  const value = provider?.trim().toLowerCase() ?? '';
  if (!value || value === 'unknown' || (value.startsWith('<') && value.endsWith('>'))) {
    return 'unknown';
  }

  // OpenCode provider 可能带 namespace（例如 provider/model 或 provider.variant）。
  const first = value.split(/[/.]/)[0];
  return PROVIDER_ALIASES[first as keyof typeof PROVIDER_ALIASES] ?? first;
}

/**
 * 统一生成 Dashboard / API 统计使用的 canonical provider。
 *
 * 无歧义 alias（尤其 openai-codex）优先；其余 provider 先尝试从 model
 * 判断真实厂商，无法判断时保留规范化后的原始 provider。product 保留在
 * 参数中是为了让调用点明确区分 client 与 provider 两个正交维度。
 */
export function canonicalizeProvider({
  provider,
  product: _product,
  model,
}: ProviderCanonicalizationInput): string {
  const rawProvider = provider?.trim().toLowerCase() ?? '';
  const normalized = normalizeProviderId(provider);

  if (rawProvider === 'openai-codex' || rawProvider === 'openai_codex') {
    return 'openai';
  }

  const inferred = inferProviderFromModel(model, '');
  return inferred || normalized;
}

function modelStartsWith(value: string, prefix: string): boolean {
  if (value === prefix) return true;
  const next = value[prefix.length];
  if (!value.startsWith(prefix) || next === undefined) return false;
  if (prefix === 'qwen' && /\d/.test(next)) return true;
  return '-._/:'.includes(next);
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlModelStartsWith(modelExpression: string, prefix: string): string {
  const escaped = sqlString(prefix);
  const patterns = [
    `${modelExpression} = ${escaped}`,
    `${modelExpression} LIKE ${sqlString(`${prefix}-%`)}`,
    `${modelExpression} LIKE ${sqlString(`${prefix}.%`)}`,
    `${modelExpression} LIKE ${sqlString(`${prefix}:%`)}`,
    `${modelExpression} LIKE ${sqlString(`${prefix}/%`)}`,
    `${modelExpression} LIKE ${sqlString(`%/${prefix}`)}`,
    `${modelExpression} LIKE ${sqlString(`%/${prefix}-%`)}`,
  ];
  if (prefix === 'qwen') patterns.push(`${modelExpression} GLOB 'qwen[0-9]*'`);
  return `(${patterns.join(' OR ')})`;
}

/**
 * 生成 SQLite/D1 中与 canonicalizeProvider 等价的 CASE 表达式。
 * 仅允许由代码传入列表达式，不应把用户输入直接作为参数传入。
 */
export function canonicalProviderSqlExpression(
  providerExpression: string,
  modelExpression?: string,
): string {
  const rawProvider = `lower(trim(${providerExpression}))`;
  const model = modelExpression ? `lower(trim(${modelExpression}))` : "''";
  const aliases = Object.entries(PROVIDER_ALIASES)
    .map(([from, to]) => `WHEN ${rawProvider} = ${sqlString(from)} THEN ${sqlString(to)}`)
    .join(' ');
  const normalizedProvider = `CASE
    WHEN ${rawProvider} = ''
      OR ${rawProvider} = 'unknown'
      OR (${rawProvider} LIKE '<%' AND ${rawProvider} LIKE '%>') THEN 'unknown'
    ${aliases}
    ELSE ${rawProvider}
  END`;
  const modelRules = MODEL_PROVIDER_RULES
    .flatMap(rule => rule.prefixes.map(prefix => ({ provider: rule.provider, prefix })))
    .map(({ provider: modelProvider, prefix }) =>
      `WHEN ${sqlModelStartsWith(model, prefix)} THEN ${sqlString(modelProvider)}`,
    )
    .join(' ');

  return `(CASE
    WHEN ${rawProvider} = 'openai-codex' OR ${rawProvider} = 'openai_codex' THEN 'openai'
    ${modelRules}
    ELSE ${normalizedProvider}
  END)`;
}
