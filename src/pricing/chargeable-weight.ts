// Chargeable weight: airlines bill the greater of the actual weight and the
// volumetric weight, so light but bulky cargo pays for the space it takes.

import { toCm, toKg, type LengthUnit, type WeightUnit } from './units.ts';

/** IATA standard: 6000 cm³ of cargo counts as 1 kg. */
export const VOLUMETRIC_DIVISOR = 6000;

/** A group of identical pieces, e.g. "3 pallets of 120x100x110 cm". */
export interface Piece {
  count: number;
  length: number;
  width: number;
  height: number;
  unit: LengthUnit;
}

/** Total weight of the whole shipment. */
export interface Weight {
  value: number;
  unit: WeightUnit;
}

export interface PieceInCm {
  /** The piece as it was given, before conversion. */
  input: Piece;
  count: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  /** Volume of all pieces in this group together. */
  volumeCm3: number;
}

export interface ChargeableWeight {
  pieces: PieceInCm[];
  /** The weight as it was given, before conversion. */
  weightInput: Weight;
  totalVolumeCm3: number;
  actualKg: number;
  volumetricKg: number;
  /** Greater of actual and volumetric, rounded up to the next 0.5 kg. */
  chargeableKg: number;
  basis: 'actual' | 'volumetric';
}

/**
 * Rounds up to the next half kilogram, as airlines do (10.1 -> 10.5, 10.6 -> 11).
 * The toFixed step removes floating point noise such as 420.00000000001.
 */
export function roundUpToHalfKg(kg: number): number {
  return Math.ceil(Number((kg * 2).toFixed(6))) / 2;
}

function assertPositive(value: number, what: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${what} must be a positive number, got ${value}`);
  }
}

/**
 * Throws RangeError on impossible input (no pieces, zero or negative sizes).
 * Validation catches those earlier; this is the last line of defence.
 */
export function computeChargeableWeight(pieces: Piece[], weight: Weight): ChargeableWeight {
  if (pieces.length === 0) throw new RangeError('At least one piece is required');
  assertPositive(weight.value, 'Weight');

  const piecesInCm = pieces.map((p): PieceInCm => {
    if (!Number.isInteger(p.count) || p.count <= 0) {
      throw new RangeError(`Piece count must be a positive whole number, got ${p.count}`);
    }
    assertPositive(p.length, 'Length');
    assertPositive(p.width, 'Width');
    assertPositive(p.height, 'Height');
    const lengthCm = toCm(p.length, p.unit);
    const widthCm = toCm(p.width, p.unit);
    const heightCm = toCm(p.height, p.unit);
    return { input: { ...p }, count: p.count, lengthCm, widthCm, heightCm, volumeCm3: p.count * lengthCm * widthCm * heightCm };
  });

  const totalVolumeCm3 = piecesInCm.reduce((sum, p) => sum + p.volumeCm3, 0);
  const actualKg = toKg(weight.value, weight.unit);
  const volumetricKg = totalVolumeCm3 / VOLUMETRIC_DIVISOR;
  const basis = volumetricKg > actualKg ? 'volumetric' : 'actual';

  return {
    pieces: piecesInCm,
    weightInput: { ...weight },
    totalVolumeCm3,
    actualKg,
    volumetricKg,
    chargeableKg: roundUpToHalfKg(Math.max(actualKg, volumetricKg)),
    basis,
  };
}
