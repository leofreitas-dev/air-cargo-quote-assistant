// Demo mode: answers come from recordings in data/demo/recorded/, so anyone
// can run the pipeline without an API key. A recording can hold several
// attempts (for example a cut-off answer followed by a good one) to show the
// retry path.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { IncomingEmail } from '../domain/email.ts';
import type { Extractor, RawAttempt } from './extract.ts';

export const RecordingSchema = z.object({
  model: z.string(),
  attempts: z
    .array(
      z.object({
        stopReason: z.string(),
        /** Written by hand to show a failure path (kept when re-recording). */
        synthetic: z.boolean().optional(),
        usage: z.object({ input_tokens: z.number().int().min(0), output_tokens: z.number().int().min(0) }),
        /** A JSON answer, stored as an object to keep the file readable... */
        output: z.unknown().optional(),
        /** ...or the exact raw text, for broken answers. */
        outputText: z.string().optional(),
      }),
    )
    .min(1),
});

export class DemoExtractor implements Extractor {
  readonly mode = 'demo' as const;

  private readonly recordings: Map<string, string>;

  /** @param recordings maps a Message-ID to its recording file */
  constructor(recordings: Map<string, string>) {
    this.recordings = recordings;
  }

  /** Pairs each demo email with the recording of the same file name. */
  static fromFolders(emailIds: Map<string, string>, recordedDir: string): DemoExtractor {
    const map = new Map<string, string>();
    for (const [messageId, name] of emailIds) map.set(messageId, join(recordedDir, `${name}.json`));
    return new DemoExtractor(map);
  }

  async attempt(email: IncomingEmail, attemptNumber: number): Promise<RawAttempt> {
    const file = this.recordings.get(email.messageId);
    if (!file) throw new Error(`No recording for ${email.messageId}`);
    const recording = RecordingSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    // Past the last recorded attempt, repeat the last one.
    const a = recording.attempts[Math.min(attemptNumber, recording.attempts.length) - 1]!;
    return {
      model: recording.model,
      stopReason: a.stopReason,
      output: a.outputText ?? JSON.stringify(a.output),
      usage: { inputTokens: a.usage.input_tokens, outputTokens: a.usage.output_tokens },
    };
  }
}
