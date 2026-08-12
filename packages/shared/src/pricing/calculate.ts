import type { CostStatus } from '../types.js';
import type {
  PricingCatalog,
  ModelPricing,
  PricingTier,
  CostCalcInput,
  CostCalcResult,
} from './types.js';
import { catalog as defaultCatalog } from './catalog.js';

/**
 * Fast 模式按 Anthropic 官方公布的独立价格折算。
 * Opus 4.7 保留旧 6x 倍率供历史日志重算；Opus 4.6 现按标准价。
 * OpenAI Codex 的 fast/priority 倍率另按官方 Codex speed/API priority 口径处理。
 */
const ANTHROPIC_FAST_MULTIPLIERS: Record<string, number> = {
  'claude-opus-5': 2,
  'claude-opus-4-8': 2,
  'claude-opus-4-7': 6,
};

type ServiceTierSuffix = 'fast' | 'priority' | null;

const OPENAI_CODEX_TIER_MULTIPLIERS: Record<string, number> = {
  'gpt-5.6-sol': 2,
  'gpt-5.6-terra': 2,
  'gpt-5.6-luna': 2,
  'gpt-5.5': 2.5,
  'gpt-5.4': 2,
};

function splitServiceTierSuffix(model: string): { baseModel: string; tier: ServiceTierSuffix } {
  if (model.endsWith('-priority')) {
    return { baseModel: model.replace(/-priority$/, ''), tier: 'priority' };
  }
  if (model.endsWith('-fast')) {
    return { baseModel: model.replace(/-fast$/, ''), tier: 'fast' };
  }
  return { baseModel: model, tier: null };
}

function getServiceTierMultiplier(
  provider: string,
  product: string,
  resolvedModel: string,
  tier: ServiceTierSuffix,
): number {
  if (!tier) return 1;

  if (provider === 'openai' && product === 'codex') {
    // GPT-5.6 暂无官方 fast 倍率；priority 按 ×2
    if (tier === 'fast' && resolvedModel.startsWith('gpt-5.6')) return 1;
    return OPENAI_CODEX_TIER_MULTIPLIERS[resolvedModel] ?? 1;
  }

  if (tier === 'fast') {
    return ANTHROPIC_FAST_MULTIPLIERS[resolvedModel] ?? 1;
  }

  return 1;
}

/**
 * resolveModelPricing — alias 精确匹配，再 longest-prefix fallback。
 *
 * 跨档防护：当 model 仅在前缀后多一段"纯数字版本号"（如 `claude-opus-4-7` vs known
 * `claude-opus-4`）时，说明这是一个独立的新版本而非同 family 衍生，拒绝 fallback。
 * 这样可确保未来出现 `claude-opus-4-8` 等新版本被显式登记前，会返回 unavailable
 * 而不是默默按旧版本计算（旧版本可能贵 3 倍）。
 */
/** 剥离 Claude Code 上下文窗口标记（如 deepseek-v4-flash[1M] → deepseek-v4-flash）。 */
function stripContextWindowSuffix(model: string): string {
  return model.replace(/\[\d+[a-zA-Z]*\]$/, '');
}

function resolveModelInProduct(
  catalog: PricingCatalog,
  models: Record<string, ModelPricing>,
  model: string,
): { resolvedModel: string; pricing: ModelPricing; normalized: boolean } | null {
  // 带上下文窗口后缀的模型名（deepseek-v4-flash[1M]）统一剥离后再匹配，
  // 否则 exact/前缀回退都命中不了，会被计为 unavailable（0 元）。
  const normalizedModel = stripContextWindowSuffix(model);
  const aliasResolved = catalog.aliases[normalizedModel];
  if (aliasResolved && models[aliasResolved]) {
    // Alias 是 catalog 显式声明的等价名（如 claude-opus-4-7-20260201 → claude-opus-4-7），
    // 视为 exact 命中；只有前缀回退（fallback）才算 estimated
    return { resolvedModel: aliasResolved, pricing: models[aliasResolved], normalized: false };
  }

  if (models[normalizedModel]) {
    return { resolvedModel: normalizedModel, pricing: models[normalizedModel], normalized: false };
  }

  // longest-prefix fallback（同 family / 同档位前缀）
  for (const knownModel of Object.keys(models).sort((a, b) => b.length - a.length)) {
    if (!normalizedModel.startsWith(`${knownModel}-`)) continue;

    // 跨档防护：剥掉 known 前缀后，若 suffix 仅是版本号数字段（如 `-7`、`-7-20260201`），
    // 视为独立新版本，拒绝回退。这是为了避免 `claude-opus-4-7` 被错误归到旧 `claude-opus-4`。
    const suffix = normalizedModel.slice(knownModel.length + 1); // 去掉 "knownModel-"
    if (/^\d+(?:[-.]\d+)*(?:-\d{6,8})?$/.test(suffix)) continue;

    return { resolvedModel: knownModel, pricing: models[knownModel], normalized: true };
  }

  return null;
}

function resolveModelPricing(
  catalog: PricingCatalog,
  provider: string,
  product: string,
  model: string,
): { resolvedModel: string; pricing: ModelPricing; normalized: boolean } | null {
  const products = catalog.providers[provider];
  if (!products) return null;

  const directModels = products[product]?.models;
  if (directModels) {
    const direct = resolveModelInProduct(catalog, directModels, model);
    if (direct) return direct;
  }

  // The product identifies the client entry point and may differ from the billing product.
  const matches = Object.entries(products)
    .filter(([name]) => name !== product)
    .map(([, value]) => resolveModelInProduct(catalog, value.models, model))
    .filter((value): value is NonNullable<typeof value> => value !== null);

  return matches.length === 1 ? matches[0] : null;
}

/** 根据模型在定价目录中的唯一归属识别真实厂商。 */
export function resolveProviderForModel(
  model: string,
  fallbackProvider: string,
  catalog: PricingCatalog = defaultCatalog,
): string {
  // A configured third-party endpoint is authoritative: gateways may expose
  // Anthropic-compatible model aliases while applying their own billing.
  if (fallbackProvider !== 'anthropic' && fallbackProvider !== 'custom') {
    return fallbackProvider;
  }

  const { baseModel } = splitServiceTierSuffix(model);
  const providers = Object.entries(catalog.providers)
    // These entries mirror a canonical provider for gateway/client records;
    // they must not make model ownership ambiguous during inference.
    .filter(([provider]) => provider !== 'custom' && provider !== 'opencode-go')
    .filter(([, products]) => Object.values(products).some(
      product => resolveModelInProduct(catalog, product.models, baseModel) !== null,
    ))
    .map(([provider]) => provider);

  return providers.length === 1 ? providers[0] : fallbackProvider;
}

/** 选阶梯：按总 input（含 cached + cache_write）命中。 */
function selectTier(tiers: PricingTier[], totalInputTokens: number): { tier: PricingTier; index: number } {
  for (let i = 0; i < tiers.length; i += 1) {
    const t = tiers[i];
    if (t.threshold === undefined || totalInputTokens <= t.threshold) {
      return { tier: t, index: i };
    }
  }
  return { tier: tiers[tiers.length - 1], index: tiers.length - 1 };
}

/** 折算成 USD。 */
function toUsd(amount: number, currency: ModelPricing['currency'], catalog: PricingCatalog): number {
  if (currency === 'USD') return amount;
  const rate = catalog.fx[currency];
  return rate ? amount / rate : amount;
}

export interface CalculateCostOptions {
  /** 自定义 catalog，便于 Worker 用 env 覆盖汇率等参数。 */
  catalog?: PricingCatalog;
  /**
   * 聚合 breakdown 包含的请求/事件数。
   * 阶梯模型若只能拿到汇总 token，按「平均单次 input」估算档位；
   * requestCount > 1 时 costStatus 会标为 estimated。
   * 精确路径请在 scanner 侧按单次 event 计算并把 costUSD 上传。
   */
  requestCount?: number;
}

export function calculateCost(
  provider: string,
  product: string,
  model: string,
  tokens: CostCalcInput,
  options: CalculateCostOptions = {},
): CostCalcResult {
  const cat = options.catalog ?? defaultCatalog;

  const reasoningTokens = tokens.reasoningOutputTokens ?? 0;
  const totalTokens =
    tokens.inputTokens +
    tokens.cachedInputTokens +
    tokens.cacheWriteTokens +
    tokens.outputTokens +
    reasoningTokens;

  if (totalTokens === 0) {
    const resolved = resolveModelPricing(cat, provider, product, model);
    return {
      estimatedCostUsd: 0,
      costStatus: resolved?.pricing.force_estimated ? 'estimated' : 'exact',
      pricingVersion: cat.version,
      resolvedModel: resolved?.resolvedModel,
    };
  }

  const { baseModel, tier } = splitServiceTierSuffix(model);

  const resolved = resolveModelPricing(cat, provider, product, baseModel);
  if (!resolved) {
    return { estimatedCostUsd: 0, costStatus: 'unavailable', pricingVersion: cat.version };
  }

  const { resolvedModel, pricing, normalized } = resolved;
  let costStatus: CostStatus = normalized || pricing.force_estimated ? 'estimated' : 'exact';

  // 阶梯：按总 input（含 cached/cw）命中档位
  let unit: PricingTier;
  let matchedTierIndex: number | undefined;
  if (pricing.tiers && pricing.tiers.length > 0) {
    const totalIn = tokens.inputTokens + tokens.cachedInputTokens + tokens.cacheWriteTokens;
    const requestCount = Math.max(1, Math.floor(options.requestCount ?? 1));
    // 多事件汇总时用平均单请求 input 估档；单事件（requestCount=1）则精确。
    const tierInput = totalIn / requestCount;
    const selected = selectTier(pricing.tiers, tierInput);
    unit = selected.tier;
    matchedTierIndex = selected.index;
    if (requestCount > 1) costStatus = 'estimated';
  } else {
    unit = {
      input_per_million: pricing.input_per_million ?? 0,
      output_per_million: pricing.output_per_million ?? 0,
      cached_input_per_million: pricing.cached_input_per_million ?? null,
      cache_write_per_million: pricing.cache_write_per_million,
      cache_write_5m_per_million: pricing.cache_write_5m_per_million ?? 0,
      cache_write_1h_per_million: pricing.cache_write_1h_per_million ?? 0,
    };
  }

  // cache_write_5m/1h 在阶梯档位里如果没填，回退到顶层
  const cw5Rate = unit.cache_write_5m_per_million ?? pricing.cache_write_5m_per_million ?? 0;
  const cw1hRate = unit.cache_write_1h_per_million ?? pricing.cache_write_1h_per_million ?? 0;
  const hasGenericCacheWriteRate =
    unit.cache_write_per_million !== undefined || pricing.cache_write_per_million !== undefined;
  const genericCwRate = unit.cache_write_per_million ?? pricing.cache_write_per_million ?? 0;
  const cachedRate = unit.cached_input_per_million ?? pricing.cached_input_per_million ?? 0;
  const cacheWriteCost = hasGenericCacheWriteRate
    ? (tokens.cacheWriteTokens / 1_000_000) * genericCwRate
    : ((tokens.cacheWrite5mTokens ?? tokens.cacheWriteTokens) / 1_000_000) * cw5Rate +
      ((tokens.cacheWrite1hTokens ?? 0) / 1_000_000) * cw1hRate;

  const outputRate = unit.output_per_million ?? 0;
  let raw =
    (tokens.inputTokens / 1_000_000) * (unit.input_per_million ?? 0) +
    (tokens.cachedInputTokens / 1_000_000) * (cachedRate ?? 0) +
    cacheWriteCost +
    (tokens.outputTokens / 1_000_000) * outputRate +
    // Reasoning / thought tokens are billed at the output rate (xAI, o-series style).
    (reasoningTokens / 1_000_000) * outputRate;

  // 折算 currency → USD
  raw = toUsd(raw, pricing.currency, cat);

  const finalCost = raw * getServiceTierMultiplier(provider, product, resolvedModel, tier);

  return {
    estimatedCostUsd: Math.round(finalCost * 10000) / 10000,
    costStatus,
    pricingVersion: cat.version,
    resolvedModel,
    matchedTierIndex,
  };
}

export function getWorstCostStatus(statuses: CostStatus[]): CostStatus {
  if (statuses.includes('unavailable')) return 'unavailable';
  if (statuses.includes('estimated')) return 'estimated';
  return 'exact';
}
