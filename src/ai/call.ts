// Calling the AI safely, for any task (reading emails, writing reply text).
// An answer is only accepted after our own check; a rejected answer is
// retried, up to MAX_ATTEMPTS. Every attempt's tokens and cost are counted,
// failed ones included, because the API bills them.

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

/** Anything that can answer one kind of request: the live API or recordings. */
export interface ModelCaller<Input> {
  readonly mode: 'demo' | 'live';
  attempt(input: Input, attemptNumber: number): Promise<RawAttempt>;
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

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

export type CallOutcome<T> = { ok: true; value: T; ai: AiUsage } | { ok: false; error: string; ai: AiUsage };

export function emptyUsage(): AiUsage {
  return { model: null, attempts: [], inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

/** Rejects answers that were cut off or declined, then parses the JSON. */
export function readJson(raw: RawAttempt): Checked<unknown> {
  if (raw.stopReason === 'max_tokens') return { ok: false, error: 'Answer was cut off (max_tokens)' };
  if (raw.stopReason === 'refusal') return { ok: false, error: 'Model declined to answer' };
  try {
    return { ok: true, value: JSON.parse(raw.output) };
  } catch {
    return { ok: false, error: 'Answer is not valid JSON' };
  }
}

export async function callWithRetry<Input, T>(
  caller: ModelCaller<Input>,
  input: Input,
  check: (raw: RawAttempt) => Checked<T>,
  maxAttempts = MAX_ATTEMPTS,
): Promise<CallOutcome<T>> {
  const ai = emptyUsage();
  let lastError = 'No attempt was made';

  for (let n = 1; n <= maxAttempts; n++) {
    let raw: RawAttempt;
    try {
      raw = await caller.attempt(input, n);
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

    const result = check(raw);
    if (result.ok) {
      ai.attempts.push({ attempt: n, ok: true, usage: raw.usage });
      return { ok: true, value: result.value, ai };
    }
    lastError = result.error;
    ai.attempts.push({ attempt: n, ok: false, error: result.error, usage: raw.usage });
  }

  return { ok: false, error: `Failed after ${maxAttempts} attempts. Last error: ${lastError}`, ai };
}

/** Adds up the AI usage of several calls (e.g. reading + writing for one request). */
export function totalUsage(...usages: (AiUsage | null | undefined)[]): { inputTokens: number; outputTokens: number; costUsd: number } {
  return usages.reduce<{ inputTokens: number; outputTokens: number; costUsd: number }>(
    (sum, u) =>
      u
        ? { inputTokens: sum.inputTokens + u.inputTokens, outputTokens: sum.outputTokens + u.outputTokens, costUsd: sum.costUsd + u.costUsd }
        : sum,
    { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  );
}
