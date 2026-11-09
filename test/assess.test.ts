import { describe, expect, it } from 'vitest';
import type { IncomingEmail } from '../src/domain/email.ts';
import { ExtractionSchema, type Extraction } from '../src/domain/extraction.ts';
import { assess, type Assessment } from '../src/validation/assess.ts';
import type { PreviousRequest } from '../src/validation/duplicates.ts';

const email: IncomingEmail = {
  messageId: '<q1@mail.test>',
  from: 'ops@example-forwarder.test',
  subject: 'Quote request GRU-MIA',
  receivedAt: '2026-11-09T14:00:00Z',
  body: 'Need a quote for 3 pallets, 120x100x110 cm, 420 kg total, GRU to MIA, general cargo, ready Friday.',
};

/** The brief example, fully filled in and confident. Tests change one thing at a time. */
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
    sender: { name: 'Ana Example', company: 'Example Forwarding Ltd' },
    confidence: { origin: 0.98, destination: 0.98, pieces: 0.95, weight: 0.97, cargoType: 0.9, readyDate: 0.85 },
    ...overrides,
  });
}

const codes = (a: Assessment) => a.flags.map((f) => f.code);

describe('assess', () => {
  it('quotes a clean request with no review flags', () => {
    const a = assess(email, extraction());
    expect(a.outcome).toBe('quote');
    expect(a.needsReview).toBe(false);
    expect(a.flags).toEqual([]);
    expect(a.quote?.totalCents).toBe(270_600);
  });

  it('asks for the weight when it is missing (brief case)', () => {
    const a = assess(email, extraction({ weight: null }));
    expect(a.outcome).toBe('ask_for_info');
    expect(a.missingFields).toEqual(['weight']);
    expect(a.needsReview).toBe(true);
    expect(a.flags[0]?.message).toBe('Missing: weight');
    expect(a.quote).toBeNull();
  });

  it('turns weight per piece into a total', () => {
    const a = assess(email, extraction({ weight: { value: 140, unit: 'kg', per: 'piece' } }));
    expect(a.shipment?.weight).toEqual({ value: 420, unit: 'kg' });
  });

  it('asks for pieces, not weight, when the weight is per piece and the count is missing', () => {
    const a = assess(email, extraction({ pieces: null, weight: { value: 50, unit: 'kg', per: 'piece' } }));
    expect(a.missingFields).toEqual(['pieces']);
  });

  it('reads an airport written out in full and says so (brief case)', () => {
    const a = assess(email, extraction({ origin: 'Sao Paulo Guarulhos' }));
    expect(a.outcome).toBe('quote');
    expect(a.origin?.iata).toBe('GRU');
    expect(a.flags).toEqual([
      {
        code: 'airport_read_from_name',
        severity: 'info',
        message: 'Origin "Sao Paulo Guarulhos" read as GRU (Sao Paulo/Guarulhos International Airport)',
      },
    ]);
    expect(a.needsReview).toBe(false);
  });

  it('flags an invalid airport code and asks', () => {
    const a = assess(email, extraction({ destination: 'XYZ' }));
    expect(a.outcome).toBe('ask_for_info');
    expect(codes(a)).toContain('unknown_airport');
  });

  it('asks which airport when a city has several', () => {
    const a = assess(email, extraction({ destination: 'New York' }));
    expect(a.outcome).toBe('ask_for_info');
    expect(a.flags.find((f) => f.code === 'ambiguous_airport')?.message).toMatch(/JFK.*LGA/);
  });

  it('flags origin equal to destination', () => {
    expect(codes(assess(email, extraction({ destination: 'GRU' })))).toContain('same_origin_and_destination');
  });

  it('sends a valid route with no rate to manual pricing', () => {
    const a = assess(email, extraction({ destination: 'DXB' }));
    expect(a.outcome).toBe('manual_quote');
    expect(a.shipment?.destination).toBe('DXB');
    expect(a.flags.at(-1)?.message).toBe('No rate on file for GRU to DXB: price it by hand');
  });

  it('always sends dangerous goods to review, with the reason (brief case)', () => {
    const a = assess(
      email,
      extraction({ cargoType: 'dangerous', cargoDescription: 'lithium ion batteries UN3480' }),
    );
    expect(a.outcome).toBe('quote');
    expect(a.needsReview).toBe(true);
    expect(a.flags[0]?.message).toBe(
      'Dangerous goods (lithium ion batteries UN3480): check DG documents and airline acceptance before sending',
    );
  });

  it('sends perishables to review', () => {
    expect(assess(email, extraction({ cargoType: 'perishable' })).needsReview).toBe(true);
  });

  it('quotes as general cargo when the type is not stated, without blocking', () => {
    const a = assess(email, extraction({ cargoType: null }));
    expect(a.outcome).toBe('quote');
    expect(a.needsReview).toBe(false);
    expect(codes(a)).toEqual(['cargo_type_assumed']);
  });

  it('sends low-confidence fields to review and lists them', () => {
    const a = assess(
      email,
      extraction({ confidence: { origin: 0.98, destination: 0.98, pieces: 0.6, weight: 0.97, cargoType: 0.9, readyDate: 0.5 } }),
    );
    expect(a.needsReview).toBe(true);
    expect(a.flags[0]?.message).toBe('AI is not sure about: pieces 60%, readyDate 50%');
  });

  it('ignores the confidence of fields that are empty anyway', () => {
    const a = assess(
      email,
      extraction({
        readyDate: null,
        confidence: { origin: 0.98, destination: 0.98, pieces: 0.95, weight: 0.97, cargoType: 0.9, readyDate: 0 },
      }),
    );
    expect(codes(a)).not.toContain('low_confidence');
  });

  it('flags a ready date before the email date', () => {
    expect(codes(assess(email, extraction({ readyDate: '2026-11-01' })))).toContain('ready_date_in_past');
  });

  it('marks urgent requests as priority without sending them to review', () => {
    const a = assess(email, extraction({ urgent: true }));
    expect(a.priority).toBe('urgent');
    expect(a.needsReview).toBe(false);
  });

  it('recognises an email that is not a quote request (brief case)', () => {
    const a = assess(email, extraction({ isQuoteRequest: false }));
    expect(a.outcome).toBe('not_a_quote');
    expect(a.needsReview).toBe(true);
  });

  describe('duplicates (brief case: the same request sent twice)', () => {
    const first = assess(email, extraction());
    const history: PreviousRequest[] = [
      { id: 'REQ-1', messageId: email.messageId, fingerprint: first.fingerprint, receivedAt: email.receivedAt },
    ];

    it('ignores the same email delivered twice', () => {
      const a = assess(email, extraction(), { history });
      expect(a.outcome).toBe('duplicate');
      expect(a.duplicateOf).toBe('REQ-1');
      expect(a.needsReview).toBe(false);
    });

    it('sends the same shipment in a new email to review', () => {
      const resent = { ...email, messageId: '<q2@mail.test>', receivedAt: '2026-11-09T16:30:00Z' };
      const a = assess(resent, extraction({ origin: 'Sao Paulo Guarulhos' }), { history });
      expect(a.outcome).toBe('duplicate');
      expect(a.needsReview).toBe(true);
      expect(a.flags.at(-1)?.message).toBe(
        'Same shipment already requested by this sender in request REQ-1 (2026-11-09)',
      );
    });

    it('treats a different shipment from the same sender as new', () => {
      const other = { ...email, messageId: '<q3@mail.test>' };
      expect(assess(other, extraction({ destination: 'JFK' }), { history }).outcome).toBe('quote');
    });
  });
});

describe('ExtractionSchema', () => {
  it('rejects malformed AI output instead of passing it on', () => {
    const good = extraction();
    expect(ExtractionSchema.safeParse({ ...good, pieces: [{ count: -1, length: 1, width: 1, height: 1, unit: 'cm' }] }).success).toBe(false);
    expect(ExtractionSchema.safeParse({ ...good, weight: { value: 10, unit: 'tons', per: 'total' } }).success).toBe(false);
    expect(ExtractionSchema.safeParse({ ...good, readyDate: 'next Friday' }).success).toBe(false);
    expect(ExtractionSchema.safeParse({ ...good, confidence: { ...good.confidence, origin: 1.5 } }).success).toBe(false);
    const { urgent: _, ...withoutUrgent } = good;
    expect(ExtractionSchema.safeParse(withoutUrgent).success).toBe(false);
  });
});
