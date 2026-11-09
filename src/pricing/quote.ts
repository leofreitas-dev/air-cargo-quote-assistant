// Prices a shipment from the rate table. No AI involved: same input, same price.
// Money is kept in whole cents so totals never drift by a fraction of a cent.
// Pricing never fails silently: an unknown route is returned as an error, not a guess.

import { computeChargeableWeight, type ChargeableWeight, type Piece, type Weight } from './chargeable-weight.ts';
import { findRoute, loadDefaultTariffs, type TariffTable } from './tariffs.ts';

export interface QuoteRequest {
  origin: string;
  destination: string;
  pieces: Piece[];
  weight: Weight;
}

export interface FreightCharge {
  /** The weight break used, e.g. "+100". */
  breakLabel: string;
  /** Weight billed. Can be above the chargeable weight when a higher break is cheaper. */
  billedKg: number;
  ratePerKg: number;
  amountCents: number;
  /** True when the higher break was cheaper than the normal one. */
  higherBreakUsed: boolean;
  /** True when the computed charge was below the route minimum. */
  minimumApplied: boolean;
}

export interface SurchargeLine {
  code: string;
  name: string;
  kg: number;
  ratePerKg: number;
  amountCents: number;
}

export interface Quote {
  ok: true;
  origin: string;
  destination: string;
  currency: string;
  tariffName: string;
  weight: ChargeableWeight;
  freight: FreightCharge;
  surcharges: SurchargeLine[];
  totalCents: number;
}

export interface QuoteError {
  ok: false;
  error: 'no_rate_for_route';
  message: string;
}

export type QuoteResult = Quote | QuoteError;

export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

/**
 * kg x rate, in cents, with exact integer arithmetic. Floating point would turn
 * 10.5 x 0.85 = 8.925 into 8.92499999... and round it the wrong way.
 * Works because weights are whole half-kilos and rates have at most 2 decimals
 * (both guaranteed elsewhere). A half cent rounds up.
 */
export function chargeCents(kg: number, ratePerKg: number): number {
  const halfKilos = Math.round(kg * 2);
  const product = halfKilos * toCents(ratePerKg); // = amount in half-cents
  return Math.floor((product + 1) / 2);
}

export function priceShipment(request: QuoteRequest, table: TariffTable = loadDefaultTariffs()): QuoteResult {
  const origin = request.origin.trim().toUpperCase();
  const destination = request.destination.trim().toUpperCase();
  const route = findRoute(table, origin, destination);
  if (!route) {
    return { ok: false, error: 'no_rate_for_route', message: `No rate on file for ${origin} to ${destination}` };
  }

  const weight = computeChargeableWeight(request.pieces, request.weight);
  const kg = weight.chargeableKg;

  // The break the weight falls into...
  let index = 0;
  route.breaks.forEach((b, i) => {
    if (kg >= b.minKg) index = i;
  });
  const normal = route.breaks[index]!;
  let freight: FreightCharge = {
    breakLabel: normal.label,
    billedKg: kg,
    ratePerKg: normal.ratePerKg,
    amountCents: chargeCents(kg, normal.ratePerKg),
    higherBreakUsed: false,
    minimumApplied: false,
  };

  // ...unless billing at the start of a higher break costs less (e.g. 90 kg
  // at the +45 rate can cost more than 100 kg at the +100 rate).
  for (const higher of route.breaks.slice(index + 1)) {
    const amountCents = chargeCents(higher.minKg, higher.ratePerKg);
    if (amountCents < freight.amountCents) {
      freight = {
        breakLabel: higher.label,
        billedKg: higher.minKg,
        ratePerKg: higher.ratePerKg,
        amountCents,
        higherBreakUsed: true,
        minimumApplied: false,
      };
    }
  }

  const minimumCents = toCents(route.minimumCharge);
  if (freight.amountCents < minimumCents) {
    freight = { ...freight, amountCents: minimumCents, minimumApplied: true };
  }

  // Surcharges apply to the chargeable weight, not to a higher billed break.
  const surcharges: SurchargeLine[] = table.surcharges.map((s) => ({
    code: s.code,
    name: s.name,
    kg,
    ratePerKg: s.ratePerKg,
    amountCents: chargeCents(kg, s.ratePerKg),
  }));

  const totalCents = freight.amountCents + surcharges.reduce((sum, s) => sum + s.amountCents, 0);

  return {
    ok: true,
    origin,
    destination,
    currency: table.currency,
    tariffName: table.name,
    weight,
    freight,
    surcharges,
    totalCents,
  };
}
