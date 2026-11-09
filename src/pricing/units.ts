// Unit conversion. Everything downstream works in centimetres and kilograms.

export type LengthUnit = 'cm' | 'in';
export type WeightUnit = 'kg' | 'lb';

export const CM_PER_INCH = 2.54; // exact, by definition
export const KG_PER_POUND = 0.45359237; // exact, by definition

export function toCm(value: number, unit: LengthUnit): number {
  return unit === 'cm' ? value : value * CM_PER_INCH;
}

export function toKg(value: number, unit: WeightUnit): number {
  return unit === 'kg' ? value : value * KG_PER_POUND;
}
