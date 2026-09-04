/**
 * Worker 侧定价入口 —— 转发到 @aiusage/shared 的统一定价目录。
 * 历史 ModelPricing / PricingCatalog 类型保留 re-export 以兼容现有调用。
 */
import { calculateCost as calculateSharedCost } from '@aiusage/shared';
import type { CostCalcResult, IngestBreakdown } from '@aiusage/shared';

/**
 * Ingest pricing contract:
 * 1. OpenCode / Trae International 的 costUSD 是供应商或账户 API 返回的权威费用，
 *    只要是正数就保留，不被当前 token catalog 覆盖。
 * 2. 其他 scanner 的 costUSD 只有在 client pricingVersion 与 Worker 当前版本一致、
 *    且 pricingModelKey 可定价时才是 event-level exact。
 * 3. 其余情况统一用 shared canonical pricing 重算；版本不兼容不会混用两套结果。
 */
export function calculateIngestBreakdownCost(breakdown: IngestBreakdown): CostCalcResult {
  const calculated = calculateSharedCost(
    breakdown.provider,
    breakdown.product,
    breakdown.pricingModelKey?.trim() || breakdown.model,
    {
      inputTokens: breakdown.inputTokens,
      cachedInputTokens: breakdown.cachedInputTokens,
      cacheWriteTokens: breakdown.cacheWriteTokens,
      cacheWrite5mTokens: breakdown.cacheWrite5mTokens ?? breakdown.cacheWriteTokens,
      cacheWrite1hTokens: breakdown.cacheWrite1hTokens ?? 0,
      outputTokens: breakdown.outputTokens,
      reasoningOutputTokens: breakdown.reasoningOutputTokens,
    },
    { requestCount: breakdown.eventCount },
  );

  const reportedCost = breakdown.costUSD;
  const hasPositiveReportedCost =
    reportedCost != null &&
    Number.isFinite(reportedCost) &&
    reportedCost > 0;
  if (!hasPositiveReportedCost || reportedCost == null) return calculated;

  const hasVendorReportedCost = breakdown.product === 'opencode' || breakdown.product === 'trae-intl';
  if (hasVendorReportedCost) {
    return {
      ...calculated,
      estimatedCostUsd: reportedCost,
      costStatus: 'exact',
      pricingVersion: calculated.pricingVersion,
    };
  }

  if (
    breakdown.pricingVersion !== calculated.pricingVersion ||
    calculated.costStatus === 'unavailable'
  ) {
    return calculated;
  }

  return {
    ...calculated,
    estimatedCostUsd: reportedCost,
    costStatus: 'exact',
    pricingVersion: calculated.pricingVersion,
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
