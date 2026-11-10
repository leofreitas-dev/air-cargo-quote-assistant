// Chooses where AI answers come from: recordings (demo) or the live API.

import type { InboxEntry } from '../domain/load-emails.ts';
import { liveDraftWriter, recordedDraftWriter } from '../drafting/text.ts';
import { liveExtractor, recordedExtractor } from '../extraction/extract.ts';
import type { AiCallers } from '../pipeline/process.ts';

export const RECORDED = { extraction: 'data/demo/recorded/extraction', drafts: 'data/demo/recorded/drafts' };

/** Message-ID -> demo file name, so each email finds its recordings. */
export function namesByMessageId(inbox: InboxEntry[]): Map<string, string> {
  return new Map(inbox.map((e) => [e.email.messageId, e.name]));
}

export function demoCallers(inbox: InboxEntry[], dirs = RECORDED): AiCallers {
  const names = namesByMessageId(inbox);
  return { extractor: recordedExtractor(names, dirs.extraction), writer: recordedDraftWriter(names, dirs.drafts) };
}

export function liveCallers(apiKey: string): AiCallers {
  return { extractor: liveExtractor(apiKey), writer: liveDraftWriter(apiKey) };
}
