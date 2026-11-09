// One email through the whole pipeline: AI extraction (with retries), then
// validation, pricing and review rules in code. The result is what the
// approval page and the dashboard will show.

import type { IncomingEmail } from '../domain/email.ts';
import type { Extraction } from '../domain/extraction.ts';
import { extractWithRetry, type AiUsage, type Extractor } from '../extraction/extract.ts';
import { assess, type Assessment } from '../validation/assess.ts';
import type { PreviousRequest } from '../validation/duplicates.ts';

export interface ProcessedRequest {
  id: string;
  email: IncomingEmail;
  /** "assessed": ready for the approval queue. "error": in the error queue. */
  status: 'assessed' | 'error';
  extraction: Extraction | null;
  assessment: Assessment | null;
  error: string | null;
  ai: AiUsage;
}

export async function processEmail(
  id: string,
  email: IncomingEmail,
  extractor: Extractor,
  history: PreviousRequest[] = [],
): Promise<ProcessedRequest> {
  const extracted = await extractWithRetry(extractor, email);
  if (!extracted.ok) {
    return { id, email, status: 'error', extraction: null, assessment: null, error: extracted.error, ai: extracted.ai };
  }
  const assessment = assess(email, extracted.extraction, { history });
  return {
    id,
    email,
    status: 'assessed',
    extraction: extracted.extraction,
    assessment,
    error: null,
    ai: extracted.ai,
  };
}

/** Processes emails in order, remembering earlier ones so duplicates are caught. */
export async function processInbox(
  emails: IncomingEmail[],
  extractor: Extractor,
  firstNumber = 1,
): Promise<ProcessedRequest[]> {
  const history: PreviousRequest[] = [];
  const results: ProcessedRequest[] = [];
  for (const [i, email] of emails.entries()) {
    const id = `REQ-${String(firstNumber + i).padStart(3, '0')}`;
    const result = await processEmail(id, email, extractor, history);
    results.push(result);
    if (result.assessment) {
      history.push({
        id,
        messageId: email.messageId,
        fingerprint: result.assessment.fingerprint,
        receivedAt: email.receivedAt,
      });
    }
  }
  return results;
}
