// Puts the reply together. Code writes every block with facts in it (price,
// assumptions, questions, validity, signature); the AI only writes the
// greeting, opening and closing. If the AI fails, a plain template is used,
// so a draft always exists, and the approver is told.

import company from '../../data/company.json' with { type: 'json' };
import type { AiUsage } from '../ai/call.ts';
import type { IncomingEmail } from '../domain/email.ts';
import type { Extraction } from '../domain/extraction.ts';
import type { Assessment } from '../validation/assess.ts';
import { customerPriceBlock, describeCargo, knownSoFar } from './price-block.ts';
import { templateText, writeDraftText, type DraftContext, type DraftKind, type DraftText, type DraftWriter } from './text.ts';

export interface Draft {
  kind: DraftKind;
  to: string;
  subject: string;
  body: string;
  /** "ai": greeting, opening and closing written by the AI. "template": AI unavailable. */
  textSource: 'ai' | 'template';
  /** Shown to the approver, e.g. why the template was used. */
  warnings: string[];
  ai: AiUsage | null;
}

/** Outcomes that get a reply. Duplicates and non-quote emails wait for a person. */
export function draftKind(outcome: Assessment['outcome']): DraftKind | null {
  return outcome === 'quote' || outcome === 'ask_for_info' || outcome === 'manual_quote' ? outcome : null;
}

export function draftContext(email: IncomingEmail, x: Extraction, a: Assessment, kind: DraftKind): DraftContext {
  return {
    messageId: email.messageId,
    kind,
    subject: email.subject,
    senderName: x.sender.name,
    senderCompany: x.sender.company,
    route: `${a.origin?.iata ?? x.origin ?? '?'} -> ${a.destination?.iata ?? x.destination ?? '?'}`,
    cargo: describeCargo(x),
    urgent: x.urgent,
    dangerousGoods: x.cargoType === 'dangerous',
    perishable: x.cargoType === 'perishable',
    questionCount: a.questions.length,
  };
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The full reply text, from the AI's three parts plus the code-built blocks. */
export function composeBody(
  kind: DraftKind,
  text: DraftText,
  email: IncomingEmail,
  x: Extraction,
  a: Assessment,
  requestId: string,
): string {
  const parts: string[] = [text.greeting, text.opening];
  const notes: string[] = [...a.assumptions];

  if (kind === 'quote' && a.quote) {
    parts.push(`Quote ${requestId}\n\n${customerPriceBlock(a.quote, x)}`);
    if (x.cargoType === 'dangerous') {
      notes.push("Dangerous goods: subject to a correct Shipper's Declaration for Dangerous Goods and airline acceptance.");
    }
    if (x.cargoType === 'perishable') notes.push('Perishable cargo: temperature handling to be confirmed with the airline.');
    const validUntil = addDays(email.receivedAt, company.quoteValidityDays);
    notes.push(
      `Valid until ${validUntil}, subject to space availability at booking. ` +
        'Airport to airport; pickup, customs clearance and delivery are not included.',
    );
    if (x.readyDate && x.readyDate > validUntil) {
      notes.push(`As the cargo is ready after ${validUntil}, we will reconfirm the rate before booking.`);
    }
  }
  if (kind === 'ask_for_info') {
    parts.push(`Could you please send us:\n${a.questions.map((q) => `- ${q}`).join('\n')}`);
    const known = knownSoFar(x, { origin: a.origin?.iata, destination: a.destination?.iata });
    if (known.length) parts.push(`What we have so far:\n${known.map((k) => `- ${k}`).join('\n')}`);
  }
  if (kind === 'manual_quote') {
    parts.push(`Request ${requestId}: ${a.origin?.iata} -> ${a.destination?.iata}, ${describeCargo(x)}`);
  }

  if (notes.length) parts.push(`Notes:\n${notes.map((n) => `- ${n}`).join('\n')}`);
  parts.push(text.closing);
  parts.push(`Best regards,\n${company.desk}\n${company.name}\n${company.email}`);
  return parts.join('\n\n');
}

export async function buildDraft(
  requestId: string,
  email: IncomingEmail,
  x: Extraction,
  a: Assessment,
  writer: DraftWriter,
): Promise<Draft | null> {
  const kind = draftKind(a.outcome);
  if (!kind) return null;

  const context = draftContext(email, x, a, kind);
  const written = await writeDraftText(writer, context);
  const text = written.ok ? written.value : templateText(context);
  const warnings = written.ok ? [] : [`Reply text from the standard template: ${written.error}`];

  return {
    kind,
    to: email.from,
    subject: email.subject.toLowerCase().startsWith('re:') ? email.subject : `RE: ${email.subject}`,
    body: composeBody(kind, text, email, x, a, requestId),
    textSource: written.ok ? 'ai' : 'template',
    warnings,
    ai: written.ai.attempts.length ? written.ai : null,
  };
}
