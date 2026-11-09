// The decision step: takes the email and what the AI extracted, checks
// everything with code, prices it when possible, and says what happens next
// and why. Every request ends up in the approval queue; "needsReview" marks
// the ones a person must look at closely, with the reasons in plain words.

import type { IncomingEmail } from '../domain/email.ts';
import type { ConfidenceField, Extraction } from '../domain/extraction.ts';
import type { Piece, Weight } from '../pricing/chargeable-weight.ts';
import { priceShipment, type Quote, type QuoteRequest } from '../pricing/quote.ts';
import { loadDefaultTariffs, type TariffTable } from '../pricing/tariffs.ts';
import { resolveAirport, shortName, type Airport, type AirportMatch } from './airports.ts';
import { checkDuplicate, fingerprint, type PreviousRequest } from './duplicates.ts';

/** What happens next. */
export type Outcome =
  | 'quote' // price is ready, reply with the quote
  | 'ask_for_info' // something is missing or unclear, reply asking for it
  | 'manual_quote' // valid request, but no rate on file: a person prices it
  | 'duplicate' // already received, no new reply
  | 'not_a_quote'; // not a quote request at all

export type FlagCode =
  | 'not_a_quote_request'
  | 'missing_fields'
  | 'unknown_airport'
  | 'ambiguous_airport'
  | 'same_origin_and_destination'
  | 'no_rate_for_route'
  | 'dangerous_goods'
  | 'perishable'
  | 'low_confidence'
  | 'duplicate_email'
  | 'duplicate_shipment'
  | 'ready_date_in_past'
  | 'cargo_type_assumed'
  | 'airport_read_from_name'
  | 'airport_assumed'
  | 'urgent';

export interface Flag {
  code: FlagCode;
  /** "review": a person must check this. "info": shown, but not a problem. */
  severity: 'review' | 'info';
  message: string;
}

export type RequiredField = 'origin' | 'destination' | 'pieces' | 'weight';

export interface Assessment {
  outcome: Outcome;
  needsReview: boolean;
  priority: 'urgent' | 'normal';
  flags: Flag[];
  missingFields: RequiredField[];
  /** Customer-facing sentences the reply must include, e.g. "Quoted ex GRU; ...". */
  assumptions: string[];
  origin: Airport | null;
  destination: Airport | null;
  /** Ready to price: totals, airports resolved. Null when something is missing. */
  shipment: QuoteRequest | null;
  quote: Quote | null;
  fingerprint: string;
  duplicateOf: string | null;
}

export interface AssessOptions {
  history?: PreviousRequest[];
  tariffs?: TariffTable;
  /** Fields the AI is less sure about than this go to review. */
  minConfidence?: number;
}

export const MIN_CONFIDENCE = 0.8;

const FIELD_LABELS: Record<RequiredField, string> = {
  origin: 'origin airport',
  destination: 'destination airport',
  pieces: 'number of pieces and dimensions',
  weight: 'weight',
};

/** The weight of the whole shipment, whether the email gave it per piece or in total. */
export function totalWeight(weight: NonNullable<Extraction['weight']>, pieces: Piece[] | null): Weight | null {
  if (weight.per === 'total') return { value: weight.value, unit: weight.unit };
  if (!pieces) return null; // "50 kg each" but we do not know how many
  const count = pieces.reduce((sum, p) => sum + p.count, 0);
  return { value: weight.value * count, unit: weight.unit };
}

/** The sentence the reply uses when a city was read as its main cargo airport. */
export function airportAssumption(side: 'Origin' | 'Destination', airport: Airport, alternatives: Airport[]): string {
  const quoted = side === 'Origin' ? `Quoted ex ${airport.iata}` : `Quoted to ${airport.iata}`;
  if (alternatives.length === 0) return `${quoted}; if you need a different airport, let us know.`;
  const alt = alternatives.map((a) => `${shortName(a)} (${a.iata})`).join(' or ');
  return side === 'Origin'
    ? `${quoted}; if the cargo ships from ${alt}, let us know.`
    : `${quoted}; if the cargo goes to ${alt}, let us know.`;
}

function airportFlag(side: 'Origin' | 'Destination', match: AirportMatch): Flag | null {
  if (match.ok) {
    if (match.method === 'code') return null;
    if (match.method === 'assumed') {
      const alt = match.alternatives.map((a) => `${a.iata} (${a.name})`).join(', ');
      return {
        code: 'airport_assumed',
        severity: 'info',
        message:
          `${side} "${match.input}" assumed to be ${match.airport.iata}, the main cargo airport` +
          (alt ? `; could also be ${alt}` : '') +
          '. The reply states this assumption',
      };
    }
    return {
      code: 'airport_read_from_name',
      severity: 'info',
      message: `${side} "${match.input}" read as ${match.airport.iata} (${match.airport.name})`,
    };
  }
  if (match.reason === 'ambiguous') {
    const options = match.candidates.map((a) => `${a.iata} (${a.name})`).join(', ');
    return {
      code: 'ambiguous_airport',
      severity: 'review',
      message: `${side} "${match.input}" could be more than one airport: ${options}`,
    };
  }
  return { code: 'unknown_airport', severity: 'review', message: `${side} "${match.input}" is not a known airport` };
}

export function assess(email: IncomingEmail, extraction: Extraction, options: AssessOptions = {}): Assessment {
  const history = options.history ?? [];
  const minConfidence = options.minConfidence ?? MIN_CONFIDENCE;
  const flags: Flag[] = [];
  const x = extraction;

  // Airports: resolved by code, never by the AI.
  const originMatch = x.origin ? resolveAirport(x.origin) : null;
  const destinationMatch = x.destination ? resolveAirport(x.destination) : null;
  const origin = originMatch?.ok ? originMatch.airport : null;
  const destination = destinationMatch?.ok ? destinationMatch.airport : null;

  const weight = x.weight ? totalWeight(x.weight, x.pieces) : null;

  const fp = fingerprint({
    from: email.from,
    origin: origin?.iata ?? x.origin,
    destination: destination?.iata ?? x.destination,
    pieces: x.pieces,
    weight,
    readyDate: x.readyDate,
  });

  const base = { origin, destination, fingerprint: fp, missingFields: [] as RequiredField[], assumptions: [] as string[] };
  const finish = (outcome: Outcome, rest: Partial<Assessment> = {}): Assessment => ({
    outcome,
    needsReview: flags.some((f) => f.severity === 'review'),
    priority: x.urgent ? 'urgent' : 'normal',
    flags,
    shipment: null,
    quote: null,
    duplicateOf: null,
    ...base,
    ...rest,
  });

  if (x.urgent) flags.push({ code: 'urgent', severity: 'info', message: 'Customer marked this as urgent' });

  // 1. Not a quote request: nothing else to check.
  if (!x.isQuoteRequest) {
    flags.push({
      code: 'not_a_quote_request',
      severity: 'review',
      message: 'This email does not look like a quote request',
    });
    return finish('not_a_quote');
  }

  // 2. Duplicates: the same email again, or the same shipment in a new email.
  const dup = checkDuplicate({ messageId: email.messageId, fingerprint: fp, receivedAt: email.receivedAt }, history);
  if (dup.duplicate) {
    flags.push(
      dup.kind === 'same_email'
        ? {
            code: 'duplicate_email',
            severity: 'info',
            message: `Same email already received as request ${dup.original.id}`,
          }
        : {
            code: 'duplicate_shipment',
            severity: 'review',
            message: `Same shipment already requested by this sender in request ${dup.original.id} (${dup.original.receivedAt.slice(0, 10)})`,
          },
    );
    return finish('duplicate', { duplicateOf: dup.original.id });
  }

  // 3. Required fields.
  const missing: RequiredField[] = [];
  if (!x.origin) missing.push('origin');
  if (!x.destination) missing.push('destination');
  if (!x.pieces) missing.push('pieces');
  if (!x.weight) missing.push('weight'); // "50 kg each" without a count is covered by 'pieces'
  if (missing.length > 0) {
    flags.push({
      code: 'missing_fields',
      severity: 'review',
      message: `Missing: ${missing.map((f) => FIELD_LABELS[f]).join(', ')}`,
    });
  }
  base.missingFields = missing;

  // 4. Airports.
  for (const [side, match] of [
    ['Origin', originMatch],
    ['Destination', destinationMatch],
  ] as const) {
    const flag = match ? airportFlag(side, match) : null;
    if (flag) flags.push(flag);
    if (match?.ok && match.method === 'assumed') {
      base.assumptions.push(airportAssumption(side, match.airport, match.alternatives));
    }
  }
  if (origin && destination && origin.iata === destination.iata) {
    flags.push({
      code: 'same_origin_and_destination',
      severity: 'review',
      message: `Origin and destination are both ${origin.iata}`,
    });
  }

  // 5. Cargo type.
  const what = x.cargoDescription ? ` (${x.cargoDescription})` : '';
  if (x.cargoType === 'dangerous') {
    flags.push({
      code: 'dangerous_goods',
      severity: 'review',
      message: `Dangerous goods${what}: check DG documents and airline acceptance before sending`,
    });
  } else if (x.cargoType === 'perishable') {
    flags.push({
      code: 'perishable',
      severity: 'review',
      message: `Perishable cargo${what}: confirm temperature handling with the airline`,
    });
  } else if (x.cargoType === null) {
    flags.push({
      code: 'cargo_type_assumed',
      severity: 'info',
      message: 'Cargo type not stated: quoted as general cargo, the reply asks to confirm',
    });
    base.assumptions.push('Quoted as general cargo; please let us know if the shipment is dangerous or perishable.');
  }

  // 6. AI confidence, only for fields the AI actually filled in.
  const filled: Record<ConfidenceField, boolean> = {
    origin: x.origin !== null,
    destination: x.destination !== null,
    pieces: x.pieces !== null,
    weight: x.weight !== null,
    cargoType: x.cargoType !== null,
    readyDate: x.readyDate !== null,
  };
  const unsure = (Object.keys(filled) as ConfidenceField[]).filter(
    (f) => filled[f] && x.confidence[f] < minConfidence,
  );
  if (unsure.length > 0) {
    const list = unsure.map((f) => `${f} ${Math.round(x.confidence[f] * 100)}%`).join(', ');
    flags.push({ code: 'low_confidence', severity: 'review', message: `AI is not sure about: ${list}` });
  }

  // 7. Ready date.
  if (x.readyDate && x.readyDate < email.receivedAt.slice(0, 10)) {
    flags.push({
      code: 'ready_date_in_past',
      severity: 'review',
      message: `Ready date ${x.readyDate} is before the email date`,
    });
  }

  // 8. What happens next.
  const blocking = flags.some((f) =>
    ['missing_fields', 'unknown_airport', 'ambiguous_airport', 'same_origin_and_destination'].includes(f.code),
  );
  if (blocking || !origin || !destination || !x.pieces || !weight) return finish('ask_for_info');

  const shipment: QuoteRequest = { origin: origin.iata, destination: destination.iata, pieces: x.pieces, weight };
  const result = priceShipment(shipment, options.tariffs ?? loadDefaultTariffs());
  if (!result.ok) {
    flags.push({
      code: 'no_rate_for_route',
      severity: 'review',
      message: `${result.message}: price it by hand`,
    });
    return finish('manual_quote', { shipment });
  }
  return finish('quote', { shipment, quote: result });
}
