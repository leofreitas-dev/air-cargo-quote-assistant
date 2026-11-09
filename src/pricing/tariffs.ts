// The rate table: price per kg for each route, by weight break.
// The numbers in data/tariffs.json are fictional.

import rawTariffs from '../../data/tariffs.json' with { type: 'json' };

export interface WeightBreak {
  /** "N" (normal, under 45 kg), "+45", "+100", "+300", "+500". */
  label: string;
  /** The break applies from this weight upwards. */
  minKg: number;
  ratePerKg: number;
}

export interface RouteTariff {
  origin: string;
  destination: string;
  /** The freight charge is never below this amount. */
  minimumCharge: number;
  /** Sorted by minKg, starting at 0. */
  breaks: WeightBreak[];
}

export interface Surcharge {
  code: string;
  name: string;
  ratePerKg: number;
}

export interface TariffTable {
  name: string;
  currency: string;
  surcharges: Surcharge[];
  routes: RouteTariff[];
}

/** Returns a list of problems; an empty list means the table is usable. */
const hasAtMostTwoDecimals = (n: number) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-9;

export function checkTariffTable(table: TariffTable): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const s of table.surcharges) {
    if (!(s.ratePerKg >= 0)) problems.push(`Surcharge ${s.code} has a negative rate`);
    if (!hasAtMostTwoDecimals(s.ratePerKg)) problems.push(`Surcharge ${s.code}: rate must have at most 2 decimals`);
  }
  for (const r of table.routes) {
    const key = `${r.origin}-${r.destination}`;
    if (!/^[A-Z]{3}$/.test(r.origin) || !/^[A-Z]{3}$/.test(r.destination)) {
      problems.push(`${key}: airport codes must be 3 capital letters`);
    }
    if (seen.has(key)) problems.push(`${key}: route listed twice`);
    seen.add(key);
    if (!(r.minimumCharge >= 0)) problems.push(`${key}: minimum charge is negative`);
    if (r.breaks.length === 0 || r.breaks[0]!.minKg !== 0) {
      problems.push(`${key}: the first weight break must start at 0 kg`);
    }
    r.breaks.forEach((b, i) => {
      if (!(b.ratePerKg > 0)) problems.push(`${key} ${b.label}: rate must be positive`);
      if (!hasAtMostTwoDecimals(b.ratePerKg)) problems.push(`${key} ${b.label}: rate must have at most 2 decimals`);
      if (!Number.isInteger(b.minKg)) problems.push(`${key} ${b.label}: break weight must be a whole number of kg`);
      const prev = r.breaks[i - 1];
      if (prev && b.minKg <= prev.minKg) problems.push(`${key} ${b.label}: breaks must be in ascending order`);
    });
  }
  return problems;
}

export function loadDefaultTariffs(): TariffTable {
  const table = rawTariffs as TariffTable;
  const problems = checkTariffTable(table);
  if (problems.length > 0) {
    throw new Error(`data/tariffs.json is invalid:\n- ${problems.join('\n- ')}`);
  }
  return table;
}

export function findRoute(table: TariffTable, origin: string, destination: string): RouteTariff | undefined {
  const o = origin.trim().toUpperCase();
  const d = destination.trim().toUpperCase();
  return table.routes.find((r) => r.origin === o && r.destination === d);
}
