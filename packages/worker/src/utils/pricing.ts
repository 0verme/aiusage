/**
 * Worker 侧定价入口 —— 转发到 @aiusage/shared 的统一定价目录。
 * 历史 ModelPricing / PricingCatalog 类型保留 re-export 以兼容现有调用。
 */
import { calculateCost as calculateSharedCost } from '@aiusage/shared';
import type { CostCalcResult, CostSource, IngestBreakdown, ReportedCostSource } from '@aiusage/shared';

export interface IngestCostResult extends CostCalcResult {
  costSource: CostSource;
  reportedCostUsd?: number;
  reportedCostSource?: ReportedCostSource;
}

/**
 * Ingest pricing contract:
 * 1. Only an explicit provider_actual amount remains primary; every unclassified
 *    client amount is retained as client_estimate audit evidence.
 * 2. Catalog estimates are recalculated centrally unless a same-version client explicitly
 *    marks a per-request catalog result with disjoint token semantics.
 * 3. 其余情况统一用 shared canonical pricing 重算；版本不兼容不会混用两套结果。
 */
export function calculateIngestBreakdownCost(breakdown: IngestBreakdown, usageDate?: string): IngestCostResult {
  const codexModelTier = breakdown.product === 'codex';
  const hasPerRequestTierEvidence = breakdown.costEvidence === 'per_request';
  const pricingModel = codexModelTier && !hasPerRequestTierEvidence
    ? (breakdown.pricingModelKey?.trim() || breakdown.model).replace(/-(fast|priority)$/i, '')
    : breakdown.pricingModelKey?.trim() || breakdown.model;
  const candidate = breakdown.costUSD;
  const hasReportedAmount = candidate != null && Number.isFinite(candidate) && candidate >= 0;
  const hasVendorReportedCost = breakdown.costSource === 'provider_actual';
  const reportedCostUsd = hasReportedAmount ? candidate : undefined;
  const reportedCostSource: ReportedCostSource | undefined = !hasReportedAmount
    ? undefined
    : hasVendorReportedCost ? 'provider_actual' : 'client_estimate';

  const calculated = calculateSharedCost(
    breakdown.provider,
    breakdown.product,
    pricingModel,
    {
      inputTokens: breakdown.inputTokens,
      cachedInputTokens: breakdown.cachedInputTokens,
      cacheWriteTokens: breakdown.cacheWriteTokens,
      cacheWrite5mTokens: breakdown.cacheWrite5mTokens ?? breakdown.cacheWriteTokens,
      cacheWrite1hTokens: breakdown.cacheWrite1hTokens ?? 0,
      outputTokens: breakdown.outputTokens,
      reasoningOutputTokens: breakdown.outputTokensIncludesReasoning
        ? 0
        : breakdown.reasoningOutputTokens,
    },
    {
      usageDate,
      requestCount: breakdown.eventCount,
      costEvidence: codexModelTier && !hasPerRequestTierEvidence
        ? 'assumed_standard'
        : breakdown.costEvidence,
    },
  );

  if (hasVendorReportedCost && hasReportedAmount) {
    return {
      ...calculated,
      estimatedCostUsd: candidate!,
      costStatus: 'exact',
      costSource: 'provider_actual',
      reportedCostUsd,
      reportedCostSource,
    };
  }

  const legacyCodexOutputIncludesReasoning = breakdown.outputTokensIncludesReasoning == null
    && breakdown.product === 'codex'
    && (breakdown.provider === 'openai' || breakdown.provider === 'openai-codex' || breakdown.provider === 'openai_codex');
  const canUseSameVersionScannerCatalogEstimate = breakdown.costSource !== 'client_estimate'
    && hasReportedAmount
    && breakdown.pricingVersion === calculated.pricingVersion
    && calculated.costStatus !== 'unavailable'
    && (!codexModelTier || breakdown.costEvidence != null)
    && !legacyCodexOutputIncludesReasoning;

  if (canUseSameVersionScannerCatalogEstimate) {
    return {
      ...calculated,
      estimatedCostUsd: candidate!,
      costSource: calculated.isFree ? 'explicit_free' : 'catalog_estimate',
      reportedCostUsd: breakdown.costSource == null ? reportedCostUsd : undefined,
      reportedCostSource: breakdown.costSource == null ? reportedCostSource : undefined,
    };
  }

  return {
    ...calculated,
    costSource: calculated.isFree
      ? 'explicit_free'
      : calculated.costStatus === 'unavailable' ? 'unavailable' : 'catalog_estimate',
    reportedCostUsd,
    reportedCostSource,
  };
}

export {
  calculateCost,
  getWorstCostStatus,
  getPricingCatalog,
  catalog,
  PRICING_VERSION,
} from '@aiusage/shared';

export type {
  ModelPricing,
  PricingCatalog,
  ProductPricing,
  Currency,
  PricingTier,
  CostCalcInput,
  CostCalcResult,
} from '@aiusage/shared';
