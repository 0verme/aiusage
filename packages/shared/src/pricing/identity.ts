import {
  canonicalizeModel,
  displayModelName,
  modelProviderHint,
  normalizeModelKey,
} from '../model.js';
import type { PricingCatalog } from './types.js';
import { catalog as defaultCatalog } from './catalog.js';

export type PricingServiceTier = 'fast' | 'priority' | null;

export interface PricingIdentityInput {
  provider: string;
  product: string;
  model: string;
}

export interface PricingIdentity {
  /** 原始上报身份；用于统计、审计与回溯，永不被定价归一化覆盖。 */
  raw: PricingIdentityInput;
  /** 仅用于 catalog lookup 的规范身份。 */
  canonical: {
    provider: string;
    product: string;
    model: string;
    serviceTier: PricingServiceTier;
  };
  /** 可读的归一化规则，未发生规则转换时为空。 */
  normalization: string | null;
}

/** 贯穿 raw → pricing → canonical → display 的模型身份快照。 */
export interface ModelIdentity {
  rawModel: string;
  pricingModelKey: string;
  pricingServiceTier: PricingServiceTier;
  canonicalModel: string;
  displayName: string;
  providerPrefix?: string;
  provider?: string;
  providerLabel?: string;
  pricingNormalization: string | null;
}

/**
 * 拆分服务等级后缀。服务等级不是新的模型 SKU，定价时使用基础模型再应用倍率。
 */
export function splitPricingServiceTier(model: string): {
  baseModel: string;
  serviceTier: PricingServiceTier;
} {
  if (model.endsWith('-priority')) {
    return { baseModel: model.slice(0, -'-priority'.length), serviceTier: 'priority' };
  }
  if (model.endsWith('-fast')) {
    return { baseModel: model.slice(0, -'-fast'.length), serviceTier: 'fast' };
  }
  return { baseModel: model, serviceTier: null };
}

/**
 * 将模型名归一化到 catalog 可查找的形式：
 * - 去掉 Claude Code / 网关附带的上下文窗口标记
 * - 应用显式 alias
 * - 保留未登记的语义后缀，交给 calculateCost 的 estimated fallback 处理
 */
export function normalizePricingModel(
  model: string,
  catalog: PricingCatalog = defaultCatalog,
): { model: string; serviceTier: PricingServiceTier; normalization: string | null } {
  // Pricing gets only safe syntax normalization here. In particular, the
  // canonical MODEL_ALIASES map is intentionally not applied: a date/snapshot
  // alias may be visually mergeable while still requiring a distinct price.
  const rawModel = normalizeModelKey(model).model;
  const { baseModel, serviceTier } = splitPricingServiceTier(rawModel);
  const withoutContextWindow = baseModel.replace(/\[\d+[a-zA-Z]*\]$/, '');
  const alias = catalog.aliases[withoutContextWindow];
  const normalizedModel = alias ?? withoutContextWindow;
  const rules: string[] = [];

  if (rawModel !== model.trim()) {
    rules.push(`model-syntax:${model.trim()}->${rawModel}`);
  }
  if (withoutContextWindow !== baseModel) {
    rules.push(`model-context:${baseModel}->${withoutContextWindow}`);
  }
  if (alias && alias !== withoutContextWindow) {
    rules.push(`model-alias:${withoutContextWindow}->${alias}`);
  }
  if (serviceTier) rules.push(`service-tier:${serviceTier}`);

  return {
    model: normalizedModel,
    serviceTier,
    normalization: rules.length > 0 ? rules.join(',') : null,
  };
}

/** 返回供 catalog lookup 使用的 pricing model key（不含 service tier）。 */
export function getPricingModelKey(
  model: string,
  catalog: PricingCatalog = defaultCatalog,
): string {
  return normalizePricingModel(model, catalog).model;
}

/** 解析一次完整模型身份，供 scanner、Pricing 和展示层共享审计信息。 */
export function resolveModelIdentity(
  rawModel: string,
  catalog: PricingCatalog = defaultCatalog,
): ModelIdentity {
  const pricing = normalizePricingModel(rawModel, catalog);
  const providerHint = modelProviderHint(rawModel);
  const canonicalModel = canonicalizeModel(rawModel);
  return {
    rawModel,
    pricingModelKey: pricing.model,
    pricingServiceTier: pricing.serviceTier,
    canonicalModel,
    displayName: displayModelName(canonicalModel),
    providerPrefix: providerHint?.prefix,
    provider: providerHint?.id,
    providerLabel: providerHint?.label,
    pricingNormalization: pricing.normalization,
  };
}

/**
 * 统一处理 scanner 的 raw provider/product 与 catalog 的 pricing identity。
 *
 * pricing raw identity 仅用于定价审计；统计落库由 provider.ts 单独归一化。
 * 例如 `openai-codex/pi` 的 pricing lookup 使用 `openai/codex`，而不改变
 * `custom` / `opencode-go` 的特殊 pricing provider entry。
 */
export function normalizePricingIdentity(
  input: PricingIdentityInput,
  catalog: PricingCatalog = defaultCatalog,
): PricingIdentity {
  const raw = { ...input };
  const rawProvider = input.provider.trim().toLowerCase();
  const rawProduct = input.product.trim().toLowerCase();
  const model = normalizePricingModel(input.model, catalog);
  let provider = rawProvider;
  let product = rawProduct;
  const rules = model.normalization ? [model.normalization] : [];

  if (provider === 'openai-codex' || provider === 'openai_codex') {
    provider = 'openai';
    rules.push(`provider:${rawProvider}->${provider}`);
    if (product === 'pi' || product === 'codex') {
      product = 'codex';
      rules.push(`product:${rawProduct}->${product}`);
    }
  } else if (provider === 'xai' && product === 'pi') {
    product = 'grok-build';
    rules.push(`product:${rawProduct}->${product}`);
  } else if (provider === 'github-copilot') {
    provider = 'github';
    rules.push(`provider:${rawProvider}->${provider}`);
    if (product === 'pi') {
      product = 'copilot-cli';
      rules.push(`product:${rawProduct}->${product}`);
    }
  }

  // CCSwitch and similar Anthropic-compatible endpoints expose DeepSeek under
  // a gateway-specific product. Keep the gateway provider, but use the
  // explicitly catalogued DeepSeek pricing product.
  if (provider === 'custom' && isDeepSeekModel(model.model)) {
    if (product !== 'deepseek-chat') {
      product = 'deepseek-chat';
      rules.push(`product:${rawProduct}->${product}`);
    }
  }

  // OpenCode Go is a subscription gateway. Only its existing DeepSeek shadow
  // pricing is canonicalized; unknown gateway models must remain unavailable
  // instead of being silently charged at a vendor API price.
  if (provider === 'opencode-go' && isDeepSeekModel(model.model) && product !== 'deepseek-chat') {
    product = 'deepseek-chat';
    rules.push(`product:${rawProduct}->${product}`);
  }

  return {
    raw,
    canonical: {
      provider,
      product,
      model: model.model,
      serviceTier: model.serviceTier,
    },
    normalization: rules.length > 0 ? rules.join(';') : null,
  };
}

function isDeepSeekModel(model: string): boolean {
  return model === 'deepseek-chat'
    || model === 'deepseek-reasoner'
    || model.startsWith('deepseek-');
}
