// Reading an email with the AI. The answer is only accepted if it is valid
// JSON and matches the fixed format (ExtractionSchema). After MAX_ATTEMPTS
// failures the request goes to the error queue instead of the pipeline
// making something up.

import { join } from 'node:path';
import { callWithRetry, readJson, type CallOutcome, type Checked, type ModelCaller, type RawAttempt } from '../ai/call.ts';
import { LiveCaller } from '../ai/live.ts';
import { RecordedCaller } from '../ai/recorded.ts';
import type { IncomingEmail } from '../domain/email.ts';
import { ExtractionSchema, type Extraction } from '../domain/extraction.ts';
import { SYSTEM_PROMPT, userMessage } from './prompt.ts';

export type Extractor = ModelCaller<IncomingEmail>;

/** Checks one raw answer. Returns the extraction or the reason it was rejected. */
export function parseAttempt(raw: RawAttempt): Checked<Extraction> {
  const json = readJson(raw);
  if (!json.ok) return json;
  const parsed = ExtractionSchema.safeParse(json.value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return { ok: false, error: `Answer does not match the format: ${issues}` };
  }
  return { ok: true, value: parsed.data };
}

export async function extractWithRetry(extractor: Extractor, email: IncomingEmail): Promise<CallOutcome<Extraction>> {
  const result = await callWithRetry(extractor, email, parseAttempt);
  return result.ok ? result : { ...result, error: result.error.replace(/^Failed/, 'Extraction failed') };
}

/** Demo mode: each email is answered by data/.../<name>.json, matched by Message-ID. */
export function recordedExtractor(names: Map<string, string>, dir: string): Extractor {
  return new RecordedCaller<IncomingEmail>((email) => {
    const name = names.get(email.messageId);
    return name ? join(dir, `${name}.json`) : undefined;
  });
}

export function liveExtractor(apiKey: string, model?: string): LiveCaller<IncomingEmail> {
  return new LiveCaller<IncomingEmail>({ system: SYSTEM_PROMPT, schema: ExtractionSchema, userMessage }, { apiKey, model });
}
