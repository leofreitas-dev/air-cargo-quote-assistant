// Runs the AI extraction with retries. The AI's answer is only accepted if it
// is valid JSON and matches the fixed format (ExtractionSchema). After
// MAX_ATTEMPTS failures the request goes to the error queue instead of the
// pipeline making something up. Failed attempts still cost tokens, so they
// are counted too.

import type { IncomingEmail } from '../domain/email.ts';
import { ExtractionSchema, type Extraction } from '../domain/extraction.ts';
import { costUsd, type TokenUsage } from './cost.ts';

export const MAX_ATTEMPTS = 3;

/** One raw answer from the model (real API or a recording). */
export interface RawAttempt {
  model: string;
  /** The model's text output, expected to be JSON. */
  output: string;
  /** "end_turn" is normal; "max_tokens" means the answer was cut off. */
  stopReason: string;
  usage: TokenUsage;
}

/** Anything that can read an email: the real API client or the demo recordings. */
export interface Extractor {
  readonly mode: 'demo' | 'live';
  attempt(email: IncomingEmail, attemptNumber: number): Promise<RawAttempt>;
}

export interface AttemptLog {
  attempt: number;
  ok: boolean;
  /** Why the attempt was rejected, in plain words. */
  error?: string;
  usage: TokenUsage;
}

export interface AiUsage {
  model: string | null;
  attempts: AttemptLog[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export type ExtractionOutcome =
  | { ok: true; extraction: Extraction; ai: AiUsage }
  | { ok: false; error: string; ai: AiUsage };

/** Checks one raw answer. Returns the extraction or the reason it was rejected. */
export function parseAttempt(raw: RawAttempt): { ok: true; extraction: Extraction } | { ok: false; error: string } {
  if (raw.stopReason === 'max_tokens') return { ok: false, error: 'Answer was cut off (max_tokens)' };
  if (raw.stopReason === 'refusal') return { ok: false, error: 'Model declined to answer' };
  let json: unknown;
  try {
    json = JSON.parse(raw.output);
  } catch {
    return { ok: false, error: 'Answer is not valid JSON' };
  }
  const parsed = ExtractionSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return { ok: false, error: `Answer does not match the format: ${issues}` };
  }
  return { ok: true, extraction: parsed.data };
}

export async function extractWithRetry(
  extractor: Extractor,
  email: IncomingEmail,
  maxAttempts = MAX_ATTEMPTS,
): Promise<ExtractionOutcome> {
  const ai: AiUsage = { model: null, attempts: [], inputTokens: 0, outputTokens: 0, costUsd: 0 };
  let lastError = 'No attempt was made';

  for (let n = 1; n <= maxAttempts; n++) {
    let raw: RawAttempt;
    try {
      raw = await extractor.attempt(email, n);
    } catch (error) {
      // The call itself failed (network, API down). No tokens were billed.
      lastError = `AI call failed: ${error instanceof Error ? error.message : String(error)}`;
      ai.attempts.push({ attempt: n, ok: false, error: lastError, usage: { inputTokens: 0, outputTokens: 0 } });
      continue;
    }

    ai.model = raw.model;
    ai.inputTokens += raw.usage.inputTokens;
    ai.outputTokens += raw.usage.outputTokens;
    ai.costUsd += costUsd(raw.model, raw.usage);

    const result = parseAttempt(raw);
    if (result.ok) {
      ai.attempts.push({ attempt: n, ok: true, usage: raw.usage });
      return { ok: true, extraction: result.extraction, ai };
    }
    lastError = result.error;
    ai.attempts.push({ attempt: n, ok: false, error: result.error, usage: raw.usage });
  }

  return { ok: false, error: `Extraction failed after ${maxAttempts} attempts. Last error: ${lastError}`, ai };
}
