import { describe, expect, it } from 'vitest';
import { computeChargeableWeight, roundUpToHalfKg } from '../src/pricing/chargeable-weight.ts';

describe('roundUpToHalfKg', () => {
  it.each([
    [10, 10],
    [10.1, 10.5],
    [10.5, 10.5],
    [10.51, 11],
    [0.2, 0.5],
  ])('%d kg -> %d kg', (input, expected) => {
    expect(roundUpToHalfKg(input)).toBe(expected);
  });

  it('ignores floating point noise instead of adding half a kilo', () => {
    expect(roundUpToHalfKg(420.0000000000001)).toBe(420);
  });
});

describe('computeChargeableWeight', () => {
  it('uses volumetric weight for bulky cargo (the brief example)', () => {
    // 3 pallets 120x100x110 cm = 3,960,000 cm3 / 6000 = 660 kg > 420 kg actual
    const w = computeChargeableWeight([{ count: 3, length: 120, width: 100, height: 110, unit: 'cm' }], {
      value: 420,
      unit: 'kg',
    });
    expect(w.totalVolumeCm3).toBe(3_960_000);
    expect(w.volumetricKg).toBe(660);
    expect(w.chargeableKg).toBe(660);
    expect(w.basis).toBe('volumetric');
  });

  it('uses actual weight for dense cargo', () => {
    const w = computeChargeableWeight([{ count: 1, length: 50, width: 40, height: 30, unit: 'cm' }], {
      value: 90,
      unit: 'kg',
    });
    expect(w.volumetricKg).toBe(10);
    expect(w.chargeableKg).toBe(90);
    expect(w.basis).toBe('actual');
  });

  it('adds up several pieces with different sizes', () => {
    const w = computeChargeableWeight(
      [
        { count: 2, length: 100, width: 60, height: 50, unit: 'cm' }, // 600,000 cm3
        { count: 1, length: 60, width: 60, height: 60, unit: 'cm' }, // 216,000 cm3
      ],
      { value: 50, unit: 'kg' },
    );
    expect(w.totalVolumeCm3).toBe(816_000);
    expect(w.volumetricKg).toBe(136);
    expect(w.chargeableKg).toBe(136);
  });

  it('converts inches and pounds before comparing', () => {
    // 1 x 48x40x40 in = 121.92 x 101.6 x 101.6 cm = 1,258,526.6 cm3 -> 209.75 kg volumetric
    // 500 lb = 226.80 kg actual -> actual wins, rounded up to 227 kg
    const w = computeChargeableWeight([{ count: 1, length: 48, width: 40, height: 40, unit: 'in' }], {
      value: 500,
      unit: 'lb',
    });
    expect(w.volumetricKg).toBeCloseTo(209.75, 2);
    expect(w.actualKg).toBeCloseTo(226.796, 3);
    expect(w.chargeableKg).toBe(227);
    expect(w.basis).toBe('actual');
    expect(w.pieces[0]!.input.unit).toBe('in');
    expect(w.weightInput).toEqual({ value: 500, unit: 'lb' });
  });

  it('rejects impossible input', () => {
    const piece = { count: 1, length: 10, width: 10, height: 10, unit: 'cm' as const };
    const kg = { value: 5, unit: 'kg' as const };
    expect(() => computeChargeableWeight([], kg)).toThrow(RangeError);
    expect(() => computeChargeableWeight([{ ...piece, count: 0 }], kg)).toThrow(RangeError);
    expect(() => computeChargeableWeight([{ ...piece, count: 1.5 }], kg)).toThrow(RangeError);
    expect(() => computeChargeableWeight([{ ...piece, height: -1 }], kg)).toThrow(RangeError);
    expect(() => computeChargeableWeight([piece], { value: 0, unit: 'kg' })).toThrow(RangeError);
    expect(() => computeChargeableWeight([piece], { value: Number.NaN, unit: 'kg' })).toThrow(RangeError);
  });
});
