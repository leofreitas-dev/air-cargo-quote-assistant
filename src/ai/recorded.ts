// Demo mode: answers come from recording files, so anyone can run the
// pipeline without an API key. A recording can hold several attempts (for
// example a cut-off answer followed by a good one) to show the retry path.

import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import type { ModelCaller, RawAttempt } from './call.ts';

export const RecordingSchema = z.object({
  note: z.string().optional(),
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
export type Recording = z.infer<typeof RecordingSchema>;

export function readRecording(file: string): Recording | null {
  if (!existsSync(file)) return null;
  return RecordingSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

export class RecordedCaller<Input> implements ModelCaller<Input> {
  readonly mode = 'demo' as const;
  private readonly fileFor: (input: Input) => string | undefined;

  /** @param fileFor says which recording file answers a given input */
  constructor(fileFor: (input: Input) => string | undefined) {
    this.fileFor = fileFor;
  }

  async attempt(input: Input, attemptNumber: number): Promise<RawAttempt> {
    const file = this.fileFor(input);
    const recording = file ? readRecording(file) : null;
    if (!recording) throw new Error(`No recording${file ? ` at ${file}` : ''}`);
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
