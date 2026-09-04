/**
 * 模型维度的统一规则。
 *
 * 这里的 canonical model 只服务于展示与统计聚合，不能替代 pricing
 * identity。定价仍然使用 pricing/identity.ts 中的 catalog 规则，以便保留
 * snapshot、service tier 和不同价格 SKU 的区别。
 */

export interface NormalizedModelKey {
  /** 去掉已知 provider namespace 后的安全规范 key。 */
  model: string;
  /** 仅在 namespace 确实属于 known provider 时返回。 */
  providerPrefix?: string;
  /** known provider 的 canonical id。 */
  provider?: string;
}

export interface ModelProviderHint {
  id: string;
  label: string;
  prefix: string;
}

export interface ModelAliasAuditGroup {
  canonicalModel: string;
  rawModels: string[];
  normalizedModels: string[];
  explicitAliases: string[];
}

export interface ModelAliasAuditCandidate {
  rawModel: string;
  normalizedModel: string;
  suggestedModel: string;
  reason: 'dated-suffix' | 'version-separator' | 'canonical-collision';
}

export interface ModelAliasAuditReport {
  rawModelCount: number;
  canonicalModelCount: number;
  safeVariants: ModelAliasAuditGroup[];
  knownAliases: ModelAliasAuditGroup[];
  remainingUnknownAliases: ModelAliasAuditCandidate[];
}

type ModelAliasGroupAccumulator = {
  rawModels: Set<string>;
  normalizedModels: Set<string>;
};

/**
 * 只允许这些明确登记的 namespace 被从模型展示名中拆出。
 * 未登记的 `foo/bar` 会完整保留，避免误删用户自定义模型信息。
 */
export const MODEL_PROVIDER_PREFIXES = {
  anthropic: 'anthropic',
  openai: 'openai',
  'openai-codex': 'openai',
  zai: 'zhipu',
  'zai-org': 'zhipu',
  zhipu: 'zhipu',
  zhipuai: 'zhipu',
  deepseek: 'deepseek',
  google: 'google',
  vertex: 'google',
  'vertex-ai': 'google',
  xai: 'xai',
  alibaba: 'alibaba',
  qwen: 'alibaba',
  moonshot: 'moonshot',
  moonshotai: 'moonshot',
  kimi: 'moonshot',
  github: 'github',
  'github-copilot': 'github',
  copilot: 'github',
  mistral: 'mistralai',
  mistralai: 'mistralai',
  meta: 'meta_llama',
  'meta-llama': 'meta_llama',
  cohere: 'cohere',
  perplexity: 'perplexity',
  groq: 'groq',
  minimax: 'minimax',
  minimaxai: 'minimax',
  'minimax-ai': 'minimax',
  azure: 'azure_ai',
  'azure-ai': 'azure_ai',
  bedrock: 'aws_bedrock',
  'aws-bedrock': 'aws_bedrock',
  openrouter: 'openrouter',
  together: 'together_ai',
  'together-ai': 'together_ai',
  fireworks: 'fireworks_ai',
  'fireworks-ai': 'fireworks_ai',
  siliconflow: 'siliconflow',
  'silicon-flow': 'siliconflow',
  deepinfra: 'deepinfra',
} as const satisfies Record<string, string>;

const MODEL_PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  zhipu: 'Z.AI',
  deepseek: 'DeepSeek',
  google: 'Google',
  xai: 'xAI',
  alibaba: 'Alibaba',
  moonshot: 'Kimi / Moonshot',
  github: 'GitHub',
  mistralai: 'Mistral',
  meta_llama: 'Meta',
  cohere: 'Cohere',
  perplexity: 'Perplexity',
  groq: 'Groq',
  minimax: 'MiniMax',
  azure_ai: 'Azure',
  aws_bedrock: 'AWS Bedrock',
  openrouter: 'OpenRouter',
  together_ai: 'Together AI',
  fireworks_ai: 'Fireworks AI',
  siliconflow: 'SiliconFlow',
  deepinfra: 'DeepInfra',
};

/**
 * 高风险等价关系必须逐条登记；这里绝不自动删除所有日期或版本后缀。
 * key/value 都是 canonical safe normalization 后的模型 key。
 */
export const MODEL_ALIASES = {
  'deepseek-v4-flash-0731': 'deepseek-v4-flash',

  // 当前历史数据同时出现 4-5/4.5、4-6/4.6 等同一版本写法。
  'claude-opus-4-8': 'claude-opus-4.8',
  'claude-opus-4-7': 'claude-opus-4.7',
  'claude-opus-4-7-20260201': 'claude-opus-4.7',
  'claude-opus-4-6': 'claude-opus-4.6',
  'claude-opus-4-6-20250301': 'claude-opus-4.6',
  'claude-opus-4-5': 'claude-opus-4.5',
  'claude-opus-4-5-20251101': 'claude-opus-4.5',
  'claude-sonnet-4-6': 'claude-sonnet-4.6',
  'claude-sonnet-4-6-20250301': 'claude-sonnet-4.6',
  'claude-sonnet-4-5': 'claude-sonnet-4.5',
  'claude-sonnet-4-5-20250929': 'claude-sonnet-4.5',
  'claude-haiku-4-5': 'claude-haiku-4.5',
  'claude-haiku-4-5-20251001': 'claude-haiku-4.5',
} as const satisfies Readonly<Record<string, string>>;

const MODEL_PROVIDER_PREFIX_ENTRIES = Object.entries(MODEL_PROVIDER_PREFIXES)
  .sort(([left], [right]) => right.length - left.length);

/** 安全规范化：只处理空白、大小写、下划线和重复分隔符。 */
export function normalizeModelKey(rawModel?: string | null): NormalizedModelKey {
  const input = typeof rawModel === 'string' ? rawModel.trim() : '';
  if (!input) return { model: 'unknown' };

  const normalized = normalizeSeparators(input.toLowerCase());
  const slashIndex = normalized.indexOf('/');
  if (slashIndex > 0) {
    const prefix = normalized.slice(0, slashIndex);
    const provider = MODEL_PROVIDER_PREFIXES[prefix as keyof typeof MODEL_PROVIDER_PREFIXES];
    if (provider) {
      const model = normalizeSeparators(normalized.slice(slashIndex + 1).replace(/^\/+/, ''));
      return {
        model: model || 'unknown',
        providerPrefix: prefix,
        provider,
      };
    }
  }

  return { model: normalized };
}

/** 将 raw model 映射到 Dashboard 使用的稳定 canonical ID。 */
export function canonicalizeModel(rawModel?: string | null): string {
  const normalized = normalizeModelKey(rawModel).model;
  return resolveModelAlias(normalized);
}

/** 返回 raw model 中明确登记的 provider namespace；无则返回 undefined。 */
export function modelProviderHint(rawModel?: string | null): ModelProviderHint | undefined {
  const normalized = normalizeModelKey(rawModel);
  if (!normalized.providerPrefix || !normalized.provider) return undefined;
  return {
    id: normalized.provider,
    label: MODEL_PROVIDER_LABELS[normalized.provider] ?? normalized.provider,
    prefix: normalized.providerPrefix,
  };
}

/** 供 UI 使用的品牌化名称；不会改变 canonical ID。 */
export function displayModelName(model?: string | null): string {
  const canonical = canonicalizeModel(model);
  if (!canonical || canonical === 'unknown' || canonical === '<synthetic>') return 'Other';
  return canonical
    .split('/')
    .map(formatModelSegment)
    .join('/');
}

/**
 * 审计一批真实模型名：安全变体与显式 alias 会被归档，仍可能是 alias
 * 的高风险写法只报告不合并，便于人工确认后逐条加入 MODEL_ALIASES。
 */
export function auditModelAliases(
  rawModels: Iterable<string | null | undefined>,
): ModelAliasAuditReport {
  const uniqueRawModels = new Set<string>();
  const grouped = new Map<string, ModelAliasGroupAccumulator>();

  for (const value of rawModels) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) continue;
    uniqueRawModels.add(raw);
    const normalized = normalizeModelKey(raw).model;
    const canonical = resolveModelAlias(normalized);
    const group = grouped.get(canonical) ?? {
      rawModels: new Set<string>(),
      normalizedModels: new Set<string>(),
    };
    group.rawModels.add(raw);
    group.normalizedModels.add(normalized);
    grouped.set(canonical, group);
  }

  const allGroups = buildModelAliasGroups(grouped);
  const groups = allGroups
    .filter((group) =>
      group.rawModels.length > 1
      || group.normalizedModels.length > 1
      || group.explicitAliases.length > 0,
    )
    .sort((left, right) => left.canonicalModel.localeCompare(right.canonicalModel));
  const safeVariants = groups.filter((group) =>
    group.normalizedModels.length === 1 && group.explicitAliases.length === 0,
  );
  const knownAliases = groups.filter(isKnownAliasGroup);
  const remainingUnknownAliases = collectUnknownAliasCandidates(allGroups, knownAliases);

  return {
    rawModelCount: uniqueRawModels.size,
    canonicalModelCount: grouped.size,
    safeVariants,
    knownAliases,
    remainingUnknownAliases,
  };
}

/**
 * 生成与 canonicalizeModel 等价的 SQLite 表达式。
 * 表达式只由代码内的固定规则生成，调用方不得把用户输入作为 expression 传入。
 */
export function canonicalModelSqlExpression(modelExpression: string): string {
  const normalized = sqlNormalizeModel(modelExpression);
  const stripped = `(CASE
${MODEL_PROVIDER_PREFIX_ENTRIES.map(([prefix]) =>
    `    WHEN ${normalized} LIKE ${sqlString(`${prefix}/%`)} THEN substr(${normalized}, ${prefix.length + 2})`,
  ).join('\n')}
    ELSE ${normalized}
  END)`;
  const aliases = Object.entries(MODEL_ALIASES)
    .map(([from, to]) => `    WHEN ${stripped} = ${sqlString(from)} THEN ${sqlString(to)}`)
    .join('\n');

  return `(CASE
${aliases}
    ELSE ${stripped}
  END)`;
}

function buildModelAliasGroups(
  grouped: Map<string, ModelAliasGroupAccumulator>,
): ModelAliasAuditGroup[] {
  return [...grouped.entries()].map(([canonicalModel, group]) => ({
    canonicalModel,
    rawModels: [...group.rawModels].sort((left, right) => left.localeCompare(right)),
    normalizedModels: [...group.normalizedModels].sort((left, right) => left.localeCompare(right)),
    explicitAliases: [...group.normalizedModels]
      .filter((model) => model !== canonicalModel && isExplicitAliasFor(model, canonicalModel))
      .sort((left, right) => left.localeCompare(right)),
  }));
}

function isKnownAliasGroup(group: ModelAliasAuditGroup): boolean {
  return group.explicitAliases.length > 0
    && group.normalizedModels.every((model) =>
      model === group.canonicalModel || isExplicitAliasFor(model, group.canonicalModel));
}

function collectUnknownAliasCandidates(
  groups: ModelAliasAuditGroup[],
  knownAliases: ModelAliasAuditGroup[],
): ModelAliasAuditCandidate[] {
  const candidates = new Map<string, ModelAliasAuditCandidate>();
  for (const group of groups) {
    if (group.normalizedModels.length > 1 && !knownAliases.includes(group)) {
      for (const rawModel of group.rawModels) {
        addAliasCandidate(candidates, rawModel, group.canonicalModel, 'canonical-collision');
      }
    }
    for (const rawModel of group.rawModels) {
      collectRawAliasCandidates(candidates, rawModel);
    }
  }
  return [...candidates.values()].sort((left, right) =>
    left.rawModel.localeCompare(right.rawModel) || left.reason.localeCompare(right.reason));
}

function collectRawAliasCandidates(
  candidates: Map<string, ModelAliasAuditCandidate>,
  rawModel: string,
): void {
  const normalizedModel = normalizeModelKey(rawModel).model;
  const aliasIsUnresolved = resolveModelAlias(normalizedModel) === normalizedModel;
  if (!aliasIsUnresolved) return;

  const datedModel = normalizedModel.replace(/-\d{8}$/, '');
  if (datedModel !== normalizedModel) {
    addAliasCandidate(candidates, rawModel, datedModel, 'dated-suffix', normalizedModel);
  }

  const versionMatch = normalizedModel.match(/^(.*?)-(\d+)-(\d+)(-.*)?$/);
  if (!versionMatch) return;
  const suggestedModel = `${versionMatch[1]}-${versionMatch[2]}.${versionMatch[3]}${versionMatch[4] ?? ''}`;
  if (suggestedModel !== normalizedModel) {
    addAliasCandidate(candidates, rawModel, suggestedModel, 'version-separator', normalizedModel);
  }
}

function addAliasCandidate(
  candidates: Map<string, ModelAliasAuditCandidate>,
  rawModel: string,
  suggestedModel: string,
  reason: ModelAliasAuditCandidate['reason'],
  normalizedModel = normalizeModelKey(rawModel).model,
): void {
  candidates.set(`${rawModel}\0${reason}`, {
    rawModel,
    normalizedModel,
    suggestedModel,
    reason,
  });
}

function isExplicitAliasFor(model: string, canonicalModel: string): boolean {
  let current = model;
  const seen = new Set<string>();
  let usedAlias = false;
  while (!seen.has(current)) {
    seen.add(current);
    const next = MODEL_ALIASES[current as keyof typeof MODEL_ALIASES];
    if (!next) return usedAlias && current === canonicalModel;
    usedAlias = true;
    current = next;
  }
  return false;
}

function resolveModelAlias(model: string): string {
  let current = model;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const next = MODEL_ALIASES[current as keyof typeof MODEL_ALIASES];
    if (!next) return current;
    current = next;
  }
  return current;
}

function normalizeSeparators(value: string): string {
  return value
    .replace(/_/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function formatModelSegment(segment: string): string {
  const words = segment.split('-').filter(Boolean);
  if (words.length === 0) return segment;

  const first = words[0];
  const brand = MODEL_BRANDS[first];
  if (brand) {
    const rest = words.slice(1).map(formatModelToken);
    if ((first === 'gpt' || first === 'glm') && rest.length > 0) {
      const version = rest.shift();
      return `${brand}-${version}${rest.length > 0 ? ` ${rest.join(' ')}` : ''}`;
    }
    return [brand, ...rest].join(' ');
  }

  const embeddedBrand = first.match(/^(qwen|gemini)(\d.*)$/);
  if (embeddedBrand) {
    const rest = words.slice(1).map(formatModelToken);
    return [capitalizeBrand(embeddedBrand[1]), formatModelToken(embeddedBrand[2]), ...rest].join(' ');
  }

  if (/^o\d+(?:\.\d+)?$/i.test(first)) {
    return [`O${first.slice(1)}`, ...words.slice(1).map(formatModelToken)].join(' ');
  }

  return words.map(formatModelToken).join(' ');
}

const MODEL_BRANDS: Record<string, string> = {
  glm: 'GLM',
  gpt: 'GPT',
  deepseek: 'DeepSeek',
  claude: 'Claude',
  qwen: 'Qwen',
  gemini: 'Gemini',
  grok: 'Grok',
  kimi: 'Kimi',
  moonshot: 'Moonshot',
  mistral: 'Mistral',
  minimax: 'MiniMax',
};

const MODEL_TOKEN_LABELS: Record<string, string> = {
  api: 'API',
  cli: 'CLI',
  mcp: 'MCP',
  tts: 'TTS',
  v: 'V',
};

function formatModelToken(token: string): string {
  const lower = token.toLowerCase();
  if (MODEL_TOKEN_LABELS[lower]) return MODEL_TOKEN_LABELS[lower];
  if (/^v\d/i.test(token)) return `V${token.slice(1)}`;
  if (/^\d+(?:\.\d+)?$/.test(token)) return token;
  return token.charAt(0).toUpperCase() + token.slice(1);
}

function capitalizeBrand(value: string): string {
  return MODEL_BRANDS[value] ?? value.charAt(0).toUpperCase() + value.slice(1);
}

function sqlNormalizeModel(expression: string): string {
  let normalized = `replace(replace(replace(replace(replace(lower(trim(${expression})), '_', '-'), ' ', '-'), char(9), '-'), char(10), '-'), char(13), '-')`;
  // Model names are short; a bounded repeated replace keeps the SQL expression
  // portable across D1/SQLite while matching the runtime collapse rule.
  for (let index = 0; index < 8; index += 1) {
    normalized = `replace(${normalized}, '--', '-')`;
  }
  return `trim(${normalized}, '-')`;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
