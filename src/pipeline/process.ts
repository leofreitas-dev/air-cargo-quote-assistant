// One email through the whole pipeline: AI reads it (with retries), code
// validates, prices and applies the review rules, then the reply draft is
// put together. The result is what the approval page will show.

import { totalUsage, type AiUsage } from '../ai/call.ts';
import type { IncomingEmail } from '../domain/email.ts';
import type { Extraction } from '../domain/extraction.ts';
import { buildDraft, type Draft } from '../drafting/draft.ts';
import type { DraftWriter } from '../drafting/text.ts';
import { extractWithRetry, type Extractor } from '../extraction/extract.ts';
import { assess, type Assessment } from '../validation/assess.ts';
import type { PreviousRequest } from '../validation/duplicates.ts';

export interface ProcessedRequest {
  id: string;
  email: IncomingEmail;
  /** "assessed": ready for the approval queue. "error": in the error queue. */
  status: 'assessed' | 'error';
  extraction: Extraction | null;
  assessment: Assessment | null;
  /** Null for duplicates, non-quote emails and errors: a person decides. */
  draft: Draft | null;
  error: string | null;
  /** AI usage for reading the email. */
  ai: AiUsage;
}

export interface AiCallers {
  extractor: Extractor;
  writer: DraftWriter;
}

/** Tokens and cost of every AI call for this request (reading + writing). */
export function requestAiTotals(r: ProcessedRequest) {
  return totalUsage(r.ai, r.draft?.ai);
}

export async function processEmail(
  id: string,
  email: IncomingEmail,
  callers: AiCallers,
  history: PreviousRequest[] = [],
): Promise<ProcessedRequest> {
  const extracted = await extractWithRetry(callers.extractor, email);
  if (!extracted.ok) {
    return { id, email, status: 'error', extraction: null, assessment: null, draft: null, error: extracted.error, ai: extracted.ai };
  }
  const assessment = assess(email, extracted.value, { history });
  const draft = await buildDraft(id, email, extracted.value, assessment, callers.writer);
  return { id, email, status: 'assessed', extraction: extracted.value, assessment, draft, error: null, ai: extracted.ai };
}

/** Processes emails in order, remembering earlier ones so duplicates are caught. */
export async function processInbox(emails: IncomingEmail[], callers: AiCallers, firstNumber = 1): Promise<ProcessedRequest[]> {
  const history: PreviousRequest[] = [];
  const results: ProcessedRequest[] = [];
  for (const [i, email] of emails.entries()) {
    const id = `REQ-${String(firstNumber + i).padStart(3, '0')}`;
    const result = await processEmail(id, email, callers, history);
    results.push(result);
    if (result.assessment) {
      history.push({ id, messageId: email.messageId, fingerprint: result.assessment.fingerprint, receivedAt: email.receivedAt });
    }
  }
  return results;
}
