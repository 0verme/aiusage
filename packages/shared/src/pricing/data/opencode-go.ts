import type { ProductPricing } from '../types.js';

const goRates = {
  currency: 'USD',
  source_url: 'https://opencode.ai/console/go',
  checked_at: '2026-11-22',
  notes: 'OpenCode Go subscription allowance valuation in USD per million tokens.',
  force_estimated: true,
  exact_model_only: true,
} as const;

export const opencodeGo: Record<string, ProductPricing> = {
  pi: {
    models: {
      'gpt-5.6-luna': {
        ...goRates,
        tiers: [
          { threshold: 272_000, input_per_million: 0.2, output_per_million: 1.2, cached_input_per_million: 0.02, cache_write_per_million: 0.25 },
          { input_per_million: 0.4, output_per_million: 1.8, cached_input_per_million: 0.04, cache_write_per_million: 0.5 },
        ],
      },
      'claude-haiku-5-5': {
        ...goRates,
        tiers: [
          { threshold: 100_000, input_per_million: 0.1, output_per_million: 0.5, cached_input_per_million: 0.01, cache_write_per_million: 0.125 },
          { input_per_million: 0.5, output_per_million: 2.5, cached_input_per_million: 0.05, cache_write_per_million: 0.625 },
        ],
      },
      'glm-5.3': {
        ...goRates, input_per_million: 1.4, output_per_million: 4.4, cached_input_per_million: 0.26,
      },
    },
  },
};
