// Live mode: one structured-output call to Claude. Used for both AI tasks
// (reading emails, writing reply text), each with its own instructions and
// output format. Answers are still checked by our own code afterwards.

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import type { ModelCaller, RawAttempt } from './call.ts';
import { hasPrice } from './cost.ts';

/** The cheapest model that handles both tasks. */
export const DEFAULT_MODEL = 'claude-haiku-5-5';

export interface LiveTask<Input> {
  system: string;
  /** The output format the API must follow. */
  schema: z.ZodType;
  userMessage: (input: Input) => string;
  maxTokens?: number;
}

export class LiveCaller<Input> implements ModelCaller<Input> {
  readonly mode = 'live' as const;
  readonly model: string;
  private readonly client: Anthropic;
  private readonly task: LiveTask<Input>;

  constructor(task: LiveTask<Input>, options: { apiKey?: string; model?: string } = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    if (!hasPrice(this.model)) throw new Error(`Add a price for ${this.model} to data/ai-pricing.json first`);
    this.task = task;
    // The SDK itself retries brief network and rate-limit errors (2 times).
    this.client = new Anthropic({ apiKey: options.apiKey });
  }

  async attempt(input: Input): Promise<RawAttempt> {
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: this.task.maxTokens ?? 4000,
      // Low effort: both tasks are simple, and it keeps cost down.
      output_config: { effort: 'low', format: zodOutputFormat(this.task.schema) },
      system: this.task.system,
      messages: [{ role: 'user', content: this.task.userMessage(input) }],
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

/** Loads .env if present and returns the API key, if any. The key is never printed. */
export function loadApiKey(): string | undefined {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: demo mode only.
  }
  return process.env.ANTHROPIC_API_KEY || undefined;
}
