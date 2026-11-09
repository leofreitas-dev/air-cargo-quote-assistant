// What each AI call cost, from the token counts the API reports.
// Prices live in data/ai-pricing.json so they can be updated without touching code.

import pricing from '../../data/ai-pricing.json' with { type: 'json' };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

type PriceTable = Record<string, { inputPerMTok: number; outputPerMTok: number }>;
const PRICES: PriceTable = pricing.models;

export function hasPrice(model: string): boolean {
  return model in PRICES;
}

/** Cost in US dollars. Throws for a model with no price on file, so costs are never silently zero. */
export function costUsd(model: string, usage: TokenUsage, prices: PriceTable = PRICES): number {
  const p = prices[model];
  if (!p) throw new Error(`No price on file for model "${model}" in data/ai-pricing.json`);
  return (usage.inputTokens * p.inputPerMTok + usage.outputTokens * p.outputPerMTok) / 1_000_000;
}
