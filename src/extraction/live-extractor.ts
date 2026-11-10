// Live mode: reads the email with Claude Haiku 5.5, the cheapest model that
// handles this task. The API is asked for the fixed format (structured
// output), and the answer is still checked by our own ExtractionSchema in
// parseAttempt, the same way as in demo mode.

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { IncomingEmail } from '../domain/email.ts';
import { ExtractionSchema } from '../domain/extraction.ts';
import { hasPrice } from './cost.ts';
import type { Extractor, RawAttempt } from './extract.ts';
import { SYSTEM_PROMPT, userMessage } from './prompt.ts';

export const EXTRACTION_MODEL = 'claude-haiku-5-5';

export class LiveExtractor implements Extractor {
  readonly mode = 'live' as const;
  private readonly client: Anthropic;
  readonly model: string;

  constructor(options: { apiKey?: string; model?: string } = {}) {
    this.model = options.model ?? EXTRACTION_MODEL;
    if (!hasPrice(this.model)) throw new Error(`Add a price for ${this.model} to data/ai-pricing.json first`);
    // The SDK itself retries brief network and rate-limit errors (2 times).
    this.client = new Anthropic({ apiKey: options.apiKey });
  }

  async attempt(email: IncomingEmail): Promise<RawAttempt> {
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 4000,
      // Low effort: reading one email into a form is a simple task, and it keeps cost down.
      output_config: { effort: 'low', format: zodOutputFormat(ExtractionSchema) },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage(email) }],
    });
    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return {
      model: this.model, // the id we priced; the API echoes the same model
      output: text,
      stopReason: response.stop_reason ?? 'unknown',
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
    };
  }
}

/** Loads .env if present and says whether live mode is possible. */
export function loadApiKey(): string | undefined {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: demo mode only.
  }
  return process.env.ANTHROPIC_API_KEY || undefined;
}
