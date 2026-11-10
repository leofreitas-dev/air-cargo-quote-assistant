import { describe, expect, it } from 'vitest';
import type { ModelCaller, RawAttempt } from '../src/ai/call.ts';
import type { IncomingEmail } from '../src/domain/email.ts';
import { ExtractionSchema, type Extraction } from '../src/domain/extraction.ts';
import { buildDraft, personName } from '../src/drafting/draft.ts';
import { describeCargo } from '../src/drafting/price-block.ts';
import { checkDraftText, type DraftContext } from '../src/drafting/text.ts';
import { assess } from '../src/validation/assess.ts';

const email: IncomingEmail = {
  messageId: '<d1@mail.test>',
  from: 'ana.ribeiro@example-forwarder.test',
  subject: 'Quote request GRU-MIA',
  receivedAt: '2026-11-09T09:00:00Z',
  body: '...',
};

function extraction(overrides: Partial<Extraction> = {}): Extraction {
  return ExtractionSchema.parse({
    isQuoteRequest: true,
    origin: 'GRU',
    destination: 'MIA',
    pieces: [{ count: 3, length: 120, width: 100, height: 110, unit: 'cm' }],
    weight: { value: 420, unit: 'kg', per: 'total' },
    cargoType: 'general',
    cargoDescription: null,
    readyDate: '2026-11-13',
    urgent: false,
    sender: { name: 'Ana Ribeiro', company: 'Example Forwarding' },
    confidence: { origin: 0.95, destination: 0.95, pieces: 0.95, weight: 0.95, cargoType: 0.95, readyDate: 0.95 },
    ...overrides,
  });
}

const raw = (text: object | string): RawAttempt => ({
  model: 'claude-haiku-5-5',
  output: typeof text === 'string' ? text : JSON.stringify(text),
  stopReason: 'end_turn',
  usage: { inputTokens: 500, outputTokens: 80 },
});

const goodText = {
  greeting: 'Hello Ana,',
  opening: 'Thank you for your request. Please find our quote below.',
  closing: 'Please let us know if you would like to book.',
};

/** A writer that plays a fixed script, and remembers what it was asked. */
function writer(...steps: (RawAttempt | Error)[]): ModelCaller<DraftContext> & { seen: DraftContext[] } {
  let calls = 0;
  const seen: DraftContext[] = [];
  return {
    mode: 'demo',
    seen,
    async attempt(c) {
      seen.push(c);
      const step = steps[Math.min(calls++, steps.length - 1)]!;
      if (step instanceof Error) throw step;
      return step;
    },
  };
}

async function draftFor(x: Extraction, w = writer(raw(goodText))) {
  const a = assess(email, x);
  return { draft: await buildDraft('REQ-001', email, x, a, w), assessment: a, writer: w };
}

describe('checkDraftText', () => {
  it('accepts plain text', () => {
    expect(checkDraftText(raw(goodText)).ok).toBe(true);
  });

  it('rejects any digit, so the AI can never write a price or a weight', () => {
    const r = checkDraftText(raw({ ...goodText, opening: 'Your total is USD 2,700.' }));
    expect(r).toEqual({ ok: false, error: 'The opening contains a number, which only code may write' });
  });

  it('rejects answers in the wrong shape', () => {
    expect(checkDraftText(raw({ greeting: 'Hi' })).ok).toBe(false);
    expect(checkDraftText(raw('not json')).ok).toBe(false);
  });
});

describe('buildDraft', () => {
  it('builds a quote reply: AI text around the code-built price block', async () => {
    const { draft } = await draftFor(extraction());
    expect(draft?.kind).toBe('quote');
    expect(draft?.to).toBe(email.from);
    expect(draft?.subject).toBe('RE: Quote request GRU-MIA');
    expect(draft?.textSource).toBe('ai');
    const body = draft!.body;
    expect(body.startsWith('Hello Ana,\n\nThank you for your request.')).toBe(true);
    expect(body).toContain('Chargeable weight:  660.0 kg');
    expect(body).toMatch(/Air freight \(\+500 rate\)\s+660\.0 kg x 3\.10\s+USD\s+2,046\.00/);
    expect(body).toMatch(/Total\s+USD\s+2,706\.00/);
    expect(body).toContain('Valid until 2026-11-16');
    expect(body.trimEnd().endsWith('quotes@cumulus-cargo.test')).toBe(true);
  });

  it('never gives the AI the prices', async () => {
    const { writer: w } = await draftFor(extraction());
    expect(JSON.stringify(w.seen)).not.toMatch(/2,?706|USD|660/);
  });

  it('shows inches and pounds as given, with the conversion', async () => {
    const { draft } = await draftFor(
      extraction({
        pieces: [{ count: 1, length: 48, width: 40, height: 40, unit: 'in' }],
        weight: { value: 500, unit: 'lb', per: 'total' },
      }),
    );
    expect(draft?.body).toContain('1 x 48 x 40 x 40 in (121.92 x 101.6 x 101.6 cm)');
    expect(draft?.body).toContain('500 lb (226.8 kg)');
  });

  it('says when the higher weight break or the minimum charge was used', async () => {
    const heavy = await draftFor(extraction({ pieces: [{ count: 1, length: 50, width: 40, height: 30, unit: 'cm' }], weight: { value: 90, unit: 'kg', per: 'total' } }));
    expect(heavy.draft?.body).toContain('Air freight (+100 rate, min 100 kg)');
    const light = await draftFor(extraction({ pieces: [{ count: 1, length: 20, width: 20, height: 20, unit: 'cm' }], weight: { value: 5, unit: 'kg', per: 'total' } }));
    expect(light.draft?.body).toMatch(/Air freight \(minimum charge\)\s+USD\s+75\.00/);
  });

  it('notes that the rate will be reconfirmed when the cargo is ready after the validity date', async () => {
    const { draft } = await draftFor(extraction({ readyDate: '2026-11-20' }));
    expect(draft?.body).toContain('As the cargo is ready after 2026-11-16, we will reconfirm the rate before booking.');
  });

  it('adds the dangerous goods note', async () => {
    const { draft, writer: w } = await draftFor(extraction({ cargoType: 'dangerous', cargoDescription: 'lithium ion batteries' }));
    expect(draft?.body).toContain("Shipper's Declaration for Dangerous Goods");
    expect(w.seen[0]?.dangerousGoods).toBe(true);
  });

  it('asks for what is missing and repeats what we already know', async () => {
    const { draft } = await draftFor(extraction({ weight: null, destination: 'Lisbon' }));
    expect(draft?.kind).toBe('ask_for_info');
    expect(draft?.body).toContain('Could you please send us:\n- the total gross weight (in kg or lb)');
    expect(draft?.body).toContain('What we have so far:\n- Route: GRU -> LIS');
    expect(draft?.body).not.toContain('USD');
  });

  it('asks which airport when the city is ambiguous', async () => {
    const { draft } = await draftFor(extraction({ destination: 'New York' }));
    expect(draft?.body).toContain('- which destination airport you mean by "New York": JFK (New York John F. Kennedy) or EWR (Newark Liberty)');
  });

  it('writes a manual-pricing reply when the route has no rate', async () => {
    const { draft } = await draftFor(extraction({ destination: 'DXB' }));
    expect(draft?.kind).toBe('manual_quote');
    expect(draft?.body).toContain('Request REQ-001: GRU -> DXB');
    expect(draft?.body).not.toContain('USD');
  });

  it('writes no draft for duplicates or emails that are not quote requests', async () => {
    expect((await draftFor(extraction({ isQuoteRequest: false }))).draft).toBeNull();
  });

  it('retries when the AI writes a number, then uses its clean answer', async () => {
    const w = writer(raw({ ...goodText, opening: 'Quote valid for 7 days.' }), raw(goodText));
    const { draft } = await draftFor(extraction(), w);
    expect(draft?.textSource).toBe('ai');
    expect(draft?.ai?.attempts.map((a) => a.ok)).toEqual([false, true]);
  });

  it('falls back to the template when the AI keeps failing, and warns the approver', async () => {
    const { draft } = await draftFor(extraction({ urgent: true }), writer(new Error('API unavailable')));
    expect(draft?.textSource).toBe('template');
    expect(draft?.warnings[0]).toMatch(/^Reply text from the standard template: Draft writing failed after 3 attempts/);
    expect(draft?.body).toContain('Hello Ana,');
    expect(draft?.body).toContain('We are treating it as a priority.');
    expect(draft?.body).toMatch(/Total\s+USD\s+2,706\.00/); // the price is there either way
  });
});

describe('describeCargo', () => {
  it('does not repeat "general cargo"', () => {
    expect(describeCargo({ cargoType: 'general', cargoDescription: 'general cargo' })).toBe('General cargo');
    expect(describeCargo({ cargoType: 'general', cargoDescription: 'Auto parts, general cargo' })).toBe('General cargo (Auto parts)');
    expect(describeCargo({ cargoType: null, cargoDescription: 'AOG part' })).toBe('General cargo (assumed) (AOG part)');
  });
});

describe('personName', () => {
  it('keeps a person', () => {
    expect(personName('Ana Ribeiro', 'Andorinha Logistica')).toBe('Ana Ribeiro');
    expect(personName('José Álvares', null)).toBe('José Álvares');
  });

  it('drops teams and departments, so the reply says just "Hello,"', () => {
    expect(personName('QuickWing Ops', 'QuickWing Forwarding')).toBeNull();
    expect(personName('Logistics desk', null)).toBeNull();
    expect(personName('Billing', null)).toBeNull();
    expect(personName('Tidewater', 'Tidewater Imports')).toBeNull(); // the company name, not a person
    expect(personName('', null)).toBeNull();
    expect(personName(null, null)).toBeNull();
  });

  it('greets a team with "Hello," even if the AI copied the team name', async () => {
    const { draft, writer: w } = await draftFor(
      extraction({ sender: { name: 'QuickWing Ops', company: 'QuickWing' } }),
      writer(new Error('AI down')), // template path: no AI involved
    );
    expect(w.seen[0]?.senderName).toBeNull();
    expect(draft?.body.startsWith('Hello,\n')).toBe(true);
  });
});
