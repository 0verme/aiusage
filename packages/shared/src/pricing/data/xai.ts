import type { ProductPricing } from '../types.js';

/**
 * xAI public API list prices (shadow prices for Grok Build local scans).
 *
 * Source: https://docs.x.ai/developers/models/grok-4.6 (checked 2026-08-23)
 * Standard token rates use the official 200K long-context threshold.
 *
 * Grok Build local logs do not expose authoritative billable usage consistently,
 * so all models are force_estimated — scanner-derived token counts are heuristics.
 */
const estimated = {
  currency: 'USD' as const,
  force_estimated: true as const,
};

export const xai: Record<string, ProductPricing> = {
  'grok-build': {
    models: {
      // Code API
      'grok-build-0.1': {
        ...estimated,
        input_per_million: 1,
        output_per_million: 2,
        notes: 'Code API list price; shadow price for local Grok Build scans',
      },

      // Chat API — current flagship used by Grok Build CLI
      'grok-4.5': {
        ...estimated,
        notes: 'Chat API list price; primary Grok Build model; 200K long-context threshold',
        tiers: [
          { threshold: 200_000, input_per_million: 2, output_per_million: 6, cached_input_per_million: 0.3 },
          { input_per_million: 4, output_per_million: 12, cached_input_per_million: 0.6 },
        ],
      },

      'grok-4.6': {
        ...estimated,
        notes: 'Official xAI API list price; 200K long-context threshold',
        tiers: [
          { threshold: 200_000, input_per_million: 2, output_per_million: 6, cached_input_per_million: 0.5 },
          { input_per_million: 4, output_per_million: 12, cached_input_per_million: 1 },
        ],
      },

      'grok-4.3': {
        ...estimated,
        input_per_million: 1.25,
        output_per_million: 2.5,
        cached_input_per_million: 0.2,
      },

      'grok-4.20-0309-reasoning': {
        ...estimated,
        input_per_million: 1.25,
        output_per_million: 2.5,
        cached_input_per_million: 0.2,
      },
      'grok-4.20-0309-non-reasoning': {
        ...estimated,
        input_per_million: 1.25,
        output_per_million: 2.5,
        cached_input_per_million: 0.2,
      },
      'grok-4.20-multi-agent-0309': {
        ...estimated,
        input_per_million: 1.25,
        output_per_million: 2.5,
        cached_input_per_million: 0.2,
      },
    },
  },
};
