import { describe, expect, it } from 'vitest';
import { toCm, toKg } from '../src/pricing/units.ts';

describe('unit conversion', () => {
  it('keeps centimetres and kilograms as they are', () => {
    expect(toCm(120, 'cm')).toBe(120);
    expect(toKg(420, 'kg')).toBe(420);
  });

  it('converts inches to centimetres (1 in = 2.54 cm)', () => {
    expect(toCm(1, 'in')).toBe(2.54);
    expect(toCm(48, 'in')).toBeCloseTo(121.92, 10);
  });

  it('converts pounds to kilograms (1 lb = 0.45359237 kg)', () => {
    expect(toKg(1, 'lb')).toBe(0.45359237);
    expect(toKg(925, 'lb')).toBeCloseTo(419.573, 3);
  });
});
