import { describe, expect, it } from 'vitest';
import type { Piece } from '../src/pricing/chargeable-weight.ts';
import { formatQuote } from '../src/pricing/format.ts';
import { chargeCents, priceShipment, type Quote, type QuoteRequest } from '../src/pricing/quote.ts';

// GRU-MIA in data/tariffs.json: minimum 75; N 4.80, +45 4.10, +100 3.60, +300 3.30, +500 3.10
// Surcharges: fuel 0.85/kg, security 0.15/kg.

/** A small box (volumetric weight 1 kg) so the actual weight decides. */
const smallBox: Piece = { count: 1, length: 20, width: 20, height: 15, unit: 'cm' };

function gruMia(kg: number, pieces: Piece[] = [smallBox]): Quote {
  const request: QuoteRequest = { origin: 'GRU', destination: 'MIA', pieces, weight: { value: kg, unit: 'kg' } };
  const result = priceShipment(request);
  if (!result.ok) throw new Error(result.message);
  return result;
}

describe('chargeCents', () => {
  it('rounds half a cent up, without floating point surprises', () => {
    expect(10.5 * 0.85).not.toBe(8.925); // why we do not use plain floats
    expect(chargeCents(10.5, 0.85)).toBe(893);
    expect(chargeCents(10.5, 0.15)).toBe(158);
    expect(chargeCents(660, 3.1)).toBe(204_600);
  });
});

describe('priceShipment', () => {
  it('prices the brief example: 3 pallets 120x100x110 cm, 420 kg, GRU-MIA', () => {
    const q = gruMia(420, [{ count: 3, length: 120, width: 100, height: 110, unit: 'cm' }]);
    expect(q.weight.chargeableKg).toBe(660);
    expect(q.freight).toMatchObject({ breakLabel: '+500', billedKg: 660, ratePerKg: 3.1, amountCents: 204_600 });
    expect(q.surcharges.map((s) => s.amountCents)).toEqual([56_100, 9_900]);
    expect(q.totalCents).toBe(270_600); // USD 2,706.00
  });

  it('uses the normal (N) rate for small shipments', () => {
    const q = gruMia(20);
    expect(q.freight).toMatchObject({ breakLabel: 'N', billedKg: 20, amountCents: 9_600, higherBreakUsed: false });
  });

  it('applies the route minimum when the freight would be lower', () => {
    const q = gruMia(10.2); // 10.5 kg x 4.80 = 50.40 < 75.00
    expect(q.freight).toMatchObject({ amountCents: 7_500, minimumApplied: true });
    expect(q.totalCents).toBe(7_500 + 893 + 158);
  });

  it('picks the break the weight falls into', () => {
    expect(gruMia(150).freight).toMatchObject({ breakLabel: '+100', amountCents: 54_000 });
    expect(gruMia(300).freight).toMatchObject({ breakLabel: '+300', amountCents: 99_000 });
    expect(gruMia(800).freight).toMatchObject({ breakLabel: '+500', amountCents: 248_000 });
  });

  it('bills at a higher break when that is cheaper', () => {
    // 90 kg x 4.10 = 369.00, but 100 kg x 3.60 = 360.00
    const q = gruMia(90);
    expect(q.freight).toMatchObject({ breakLabel: '+100', billedKg: 100, amountCents: 36_000, higherBreakUsed: true });
    // Surcharges stay on the real chargeable weight (90 kg), not on 100 kg.
    expect(q.surcharges.map((s) => s.kg)).toEqual([90, 90]);
    expect(q.totalCents).toBe(36_000 + 7_650 + 1_350);
  });

  it('never charges more than the same shipment would at a higher break', () => {
    // As weight grows, freight must never go down by adding kilos.
    let previous = 0;
    for (let kg = 1; kg <= 700; kg += 0.5) {
      const amount = gruMia(kg).freight.amountCents;
      expect(amount).toBeGreaterThanOrEqual(previous);
      previous = amount;
    }
  });

  it('accepts lowercase airport codes', () => {
    const result = priceShipment({ origin: 'gru', destination: 'mia', pieces: [smallBox], weight: { value: 20, unit: 'kg' } });
    expect(result.ok && result.origin).toBe('GRU');
  });

  it('returns an error, not a guess, for a route with no rate', () => {
    const result = priceShipment({ origin: 'GRU', destination: 'XXX', pieces: [smallBox], weight: { value: 20, unit: 'kg' } });
    expect(result).toEqual({ ok: false, error: 'no_rate_for_route', message: 'No rate on file for GRU to XXX' });
  });

  it('formats a readable breakdown', () => {
    const text = formatQuote(gruMia(420, [{ count: 3, length: 120, width: 100, height: 110, unit: 'cm' }]));
    expect(text).toContain('3,960,000 cm3 / 6000 = 660.00 kg');
    expect(text).toContain('Chargeable weight: 660.0 kg  (volumetric is higher)');
    expect(text).toMatch(/TOTAL USD\s+2,706\.00/);
  });
});
