import type { ProductPricing } from '../types.js';

/**
 * DeepSeek。
 * 单价 USD / 1M tokens（DeepSeek 官方直接美元定价）。
 * 来源：https://api-docs.deepseek.com/quick_start/pricing/
 * 最近核对：2026-07-22
 */
export const deepseek: Record<string, ProductPricing> = {
  'deepseek-chat': {
    models: {
      'deepseek-v4-flash': {
        currency: 'USD',
        input_per_million: 0.14,
        cached_input_per_million: 0.0028,
        output_per_million: 0.28,
      },
      'deepseek-v4-pro': {
        currency: 'USD',
        input_per_million: 0.435,
        cached_input_per_million: 0.003625,
        output_per_million: 0.87,
      },
      // 兼容别名（chat = v4-flash 非思考，reasoner = v4-flash 思考），按 v4-flash 同价计
      'deepseek-chat': {
        currency: 'USD',
        notes: 'alias for v4-flash non-thinking',
        input_per_million: 0.14,
        cached_input_per_million: 0.0028,
        output_per_million: 0.28,
      },
      'deepseek-reasoner': {
        currency: 'USD',
        notes: 'alias for v4-flash thinking',
        input_per_million: 0.14,
        cached_input_per_million: 0.0028,
        output_per_million: 0.28,
      },
    },
  },
};
