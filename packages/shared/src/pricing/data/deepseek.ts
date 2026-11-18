import type { ProductPricing } from '../types.js';

/**
 * DeepSeek。
 * 单价 USD / 1M tokens（峰值标准价）。
 * 来源：https://api-docs.deepseek.com/quick_start/pricing/
 * 最近核对：2026-11-18。日志不保留 DeepSeek 峰谷时段，因此使用峰值标准价并标为估算。
 */
export const deepseek: Record<string, ProductPricing> = {
  'deepseek-chat': {
    models: {
      'deepseek-v4.1-flash': {
        currency: 'USD',
        source_url: 'https://api-docs.deepseek.com/quick_start/pricing/',
        checked_at: '2026-11-18',
        force_estimated: true,
        notes: 'Peak rate. Off-peak is 50% and the local usage record does not retain DeepSeek billing time or peak/off-peak evidence.',
        input_per_million: 0.3,
        cached_input_per_million: 0.006,
        output_per_million: 1.2,
      },
      'deepseek-v4-pro': {
        currency: 'USD',
        source_url: 'https://api-docs.deepseek.com/quick_start/pricing/',
        checked_at: '2026-11-18',
        force_estimated: true,
        notes: 'Peak rate. Off-peak is 50% and the local usage record does not retain DeepSeek billing time or peak/off-peak evidence.',
        input_per_million: 1.32,
        cached_input_per_million: 0.044,
        output_per_million: 3.96,
      },
      // 兼容别名（chat = v4-flash 非思考，reasoner = v4-flash 思考），按 v4-flash 同价计
      'deepseek-chat': {
        currency: 'USD',
        notes: 'legacy API alias for DeepSeek V4.1 Flash; peak rate, off-peak is 50%',
        source_url: 'https://api-docs.deepseek.com/quick_start/pricing/',
        checked_at: '2026-11-18',
        force_estimated: true,
        input_per_million: 0.3,
        cached_input_per_million: 0.006,
        output_per_million: 1.2,
      },
      'deepseek-reasoner': {
        currency: 'USD',
        notes: 'legacy API alias for DeepSeek V4.1 Flash; peak rate, off-peak is 50%',
        source_url: 'https://api-docs.deepseek.com/quick_start/pricing/',
        checked_at: '2026-11-18',
        force_estimated: true,
        input_per_million: 0.3,
        cached_input_per_million: 0.006,
        output_per_million: 1.2,
      },
    },
  },
};
