// The only part of the reply the AI writes: a greeting, an opening and a
// closing sentence. Everything with a number (prices, weights, dates) is
// placed by code between them. As a hard rule, the AI's text may not contain
// any digit; an answer with one is rejected and retried, so the AI can never
// slip a wrong number into a reply.

import { join } from 'node:path';
import { z } from 'zod';
import { callWithRetry, readJson, type CallOutcome, type Checked, type ModelCaller, type RawAttempt } from '../ai/call.ts';
import { LiveCaller } from '../ai/live.ts';
import { RecordedCaller } from '../ai/recorded.ts';

export const DraftTextSchema = z.object({
  greeting: z.string().min(1).max(80),
  opening: z.string().min(1).max(400),
  closing: z.string().min(1).max(300),
});
export type DraftText = z.infer<typeof DraftTextSchema>;

export type DraftKind = 'quote' | 'ask_for_info' | 'manual_quote';

/** What the AI is told about the request. No prices or weights: it does not need them. */
export interface DraftContext {
  messageId: string;
  kind: DraftKind;
  subject: string;
  senderName: string | null;
  senderCompany: string | null;
  route: string;
  cargo: string;
  urgent: boolean;
  dangerousGoods: boolean;
  perishable: boolean;
  /** How many things the reply asks for (ask_for_info only). */
  questionCount: number;
}

export type DraftWriter = ModelCaller<DraftContext>;

export const DRAFT_SYSTEM_PROMPT = `You write short parts of email replies for the quotes desk of an air cargo forwarder. Another system inserts the quote or the list of questions between your opening and your closing, and adds the signature.

Write three parts in plain, friendly, professional English:
- greeting: "Hello <first name>," or "Hello," when there is no name.
- opening: one or two sentences. Thank the sender and say what follows, according to the kind:
  - quote: "please find our quote below" or similar.
  - ask_for_info: we need a few more details before we can quote.
  - manual_quote: we do not have a standard rate for this route; our team is pricing it and will send the quote shortly.
  If the request is urgent, say we are treating it as a priority. If it contains dangerous goods, mention that the shipment needs dangerous goods documents and airline acceptance. If it is perishable, mention that we will confirm temperature handling with the airline.
- closing: one sentence inviting them to confirm the booking (quote), to reply with the details (ask_for_info), or to wait for our follow-up (manual_quote).

Strict rules: never write any digit or number, price, currency, weight, date, transit time or promise of space. Do not repeat the route codes or cargo details: they appear in the block below. Do not sign the email.`;

export function draftUserMessage(c: DraftContext): string {
  return [
    `Kind: ${c.kind}`,
    `Original subject: ${c.subject}`,
    `Sender name: ${c.senderName ?? 'unknown'}`,
    `Sender company: ${c.senderCompany ?? 'unknown'}`,
    `Cargo: ${c.cargo}`,
    `Urgent: ${c.urgent ? 'yes' : 'no'}`,
    `Dangerous goods: ${c.dangerousGoods ? 'yes' : 'no'}`,
    `Perishable: ${c.perishable ? 'yes' : 'no'}`,
  ].join('\n');
}

/** Accepts the AI's text only if it has the right shape and no digits. */
export function checkDraftText(raw: RawAttempt): Checked<DraftText> {
  const json = readJson(raw);
  if (!json.ok) return json;
  const parsed = DraftTextSchema.safeParse(json.value);
  if (!parsed.success) {
    return { ok: false, error: `Answer does not match the format: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}` };
  }
  for (const [part, text] of Object.entries(parsed.data)) {
    if (/\d/.test(text)) return { ok: false, error: `The ${part} contains a number, which only code may write` };
  }
  return { ok: true, value: parsed.data };
}

/** Plain text used when the AI is unavailable, so a draft always exists. */
export function templateText(c: DraftContext): DraftText {
  const first = c.senderName?.split(/\s+/)[0];
  const priority = c.urgent ? ' We are treating it as a priority.' : '';
  const dg = c.dangerousGoods ? ' As the shipment contains dangerous goods, it needs dangerous goods documents and airline acceptance.' : '';
  const openings: Record<DraftKind, string> = {
    quote: `Thank you for your request. Please find our quote below.${priority}${dg}`,
    ask_for_info: `Thank you for your request. We need a few more details before we can quote.${priority}`,
    manual_quote: `Thank you for your request. We do not have a standard rate for this route, so our team is pricing it and will send the quote shortly.${priority}`,
  };
  const closings: Record<DraftKind, string> = {
    quote: 'Please let us know if you would like to go ahead with the booking.',
    ask_for_info: 'As soon as we have these details, we will send you our quote.',
    manual_quote: 'We will be back to you with the price as soon as possible.',
  };
  return { greeting: first ? `Hello ${first},` : 'Hello,', opening: openings[c.kind], closing: closings[c.kind] };
}

export async function writeDraftText(writer: DraftWriter, context: DraftContext): Promise<CallOutcome<DraftText>> {
  const result = await callWithRetry(writer, context, checkDraftText);
  return result.ok ? result : { ...result, error: result.error.replace(/^Failed/, 'Draft writing failed') };
}

export function recordedDraftWriter(names: Map<string, string>, dir: string): DraftWriter {
  return new RecordedCaller<DraftContext>((c) => {
    const name = names.get(c.messageId);
    return name ? join(dir, `${name}.json`) : undefined;
  });
}

export function liveDraftWriter(apiKey: string, model?: string): LiveCaller<DraftContext> {
  return new LiveCaller<DraftContext>(
    { system: DRAFT_SYSTEM_PROMPT, schema: DraftTextSchema, userMessage: draftUserMessage, maxTokens: 2000 },
    { apiKey, model },
  );
}
