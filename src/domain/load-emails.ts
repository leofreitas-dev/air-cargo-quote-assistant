// Reads the demo inbox (one JSON file per email) and checks each file.

import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import type { IncomingEmail } from './email.ts';

const EmailSchema = z.object({
  messageId: z.string().min(1),
  from: z.string().min(3),
  subject: z.string(),
  receivedAt: z.iso.datetime(),
  body: z.string(),
});

export interface InboxEntry {
  /** File name without .json, e.g. "01-gru-mia-pallets". */
  name: string;
  email: IncomingEmail;
}

export function loadInbox(dir: string): InboxEntry[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const parsed = EmailSchema.safeParse(JSON.parse(readFileSync(join(dir, f), 'utf8')));
      if (!parsed.success) throw new Error(`${f} is not a valid email file: ${parsed.error.message}`);
      return { name: basename(f, '.json'), email: parsed.data };
    });
}
