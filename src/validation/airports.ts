// Turns whatever the email says ("GRU", "Sao Paulo Guarulhos", "Miami") into a
// known airport, or says clearly why it could not. It never guesses: a city
// with several airports (New York, London) is reported as ambiguous.

import rawAirports from '../../data/airports.json' with { type: 'json' };

export interface Airport {
  iata: string;
  name: string;
  city: string;
  country: string;
  aliases: string[];
}

export type MatchMethod = 'code' | 'name' | 'city';

export type AirportMatch =
  | { ok: true; airport: Airport; method: MatchMethod; input: string }
  | { ok: false; reason: 'unknown'; input: string }
  | { ok: false; reason: 'ambiguous'; input: string; candidates: Airport[] };

const AIRPORTS: Airport[] = rawAirports.airports;

/** Words that do not help identify an airport. */
const NOISE = new Set(['airport', 'international', 'intl', 'int', 'apt', 'aeroporto', 'aeropuerto', 'the', 'of']);

/** "São Paulo/Guarulhos Int'l Airport" -> "sao paulo guarulhos". */
export function normalizeName(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove accents
    .replace(/['\u2019]/g, '') // "Int'l" -> "Intl"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word && !NOISE.has(word))
    .join(' ');
}

export function findAirportByCode(code: string): Airport | undefined {
  const upper = code.trim().toUpperCase();
  return AIRPORTS.find((a) => a.iata === upper);
}

export function resolveAirport(input: string, airports: Airport[] = AIRPORTS): AirportMatch {
  const text = input.trim();
  const norm = normalizeName(text);
  if (!norm) return { ok: false, reason: 'unknown', input };

  // 1. A bare code: "GRU", "gru", "GRU airport".
  if (/^[a-z]{3}$/.test(norm)) {
    const airport = airports.find((a) => a.iata === norm.toUpperCase());
    if (airport) return { ok: true, airport, method: 'code', input };
  }

  // 2. A known code inside the text, in capitals: "Sao Paulo (GRU)".
  const codes = new Set(text.match(/\b[A-Z]{3}\b/g) ?? []);
  const inText = airports.filter((a) => codes.has(a.iata));
  if (inText.length === 1) return { ok: true, airport: inText[0]!, method: 'code', input };

  // 3. The airport name or one of its aliases: "Sao Paulo Guarulhos", "Heathrow".
  const byName = airports.filter(
    (a) => normalizeName(a.name) === norm || a.aliases.some((alias) => normalizeName(alias) === norm),
  );
  if (byName.length === 1) return { ok: true, airport: byName[0]!, method: 'name', input };

  // 4. The city: fine when the city has one airport, ambiguous otherwise.
  const byCity = airports.filter((a) => normalizeName(a.city) === norm);
  if (byCity.length === 1) return { ok: true, airport: byCity[0]!, method: 'city', input };
  if (byCity.length > 1) return { ok: false, reason: 'ambiguous', input, candidates: byCity };

  return { ok: false, reason: 'unknown', input };
}
