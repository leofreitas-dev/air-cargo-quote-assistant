// Duplicate detection, at two levels:
// 1. the same email delivered twice (same Message-ID);
// 2. the same shipment asked again in a new email (same fingerprint, within a few days).

import { createHash } from 'node:crypto';
import type { Piece, Weight } from '../pricing/chargeable-weight.ts';
import { toCm, toKg } from '../pricing/units.ts';

export interface PreviousRequest {
  id: string;
  messageId: string;
  fingerprint: string;
  receivedAt: string;
}

export interface FingerprintInput {
  from: string;
  origin: string | null;
  destination: string | null;
  pieces: Piece[] | null;
  weight: Weight | null;
  readyDate: string | null;
}

export const DUPLICATE_WINDOW_DAYS = 7;

/**
 * A short hash of what makes two requests "the same shipment". Units and
 * order do not matter: 48x40x40 in equals 121.9x101.6x101.6 cm, and
 * 100x120 equals 120x100.
 */
export function fingerprint(input: FingerprintInput): string {
  const pieces = (input.pieces ?? [])
    .map((p) => {
      const dims = [p.length, p.width, p.height].map((d) => Math.round(toCm(d, p.unit))).sort((a, b) => b - a);
      return `${p.count}x${dims.join('x')}`;
    })
    .sort()
    .join('+');
  const kg = input.weight ? Math.round(toKg(input.weight.value, input.weight.unit)) : '-';
  const key = [
    input.from.trim().toLowerCase(),
    input.origin ?? '-',
    input.destination ?? '-',
    pieces || '-',
    kg,
    input.readyDate ?? '-',
  ].join('|');
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export type DuplicateCheck =
  | { duplicate: false }
  | { duplicate: true; kind: 'same_email' | 'same_shipment'; original: PreviousRequest };

export function checkDuplicate(
  current: { messageId: string; fingerprint: string; receivedAt: string },
  history: PreviousRequest[],
  windowDays = DUPLICATE_WINDOW_DAYS,
): DuplicateCheck {
  const sameEmail = history.find((h) => h.messageId === current.messageId);
  if (sameEmail) return { duplicate: true, kind: 'same_email', original: sameEmail };

  const now = Date.parse(current.receivedAt);
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const sameShipment = history.find(
    (h) => h.fingerprint === current.fingerprint && Math.abs(now - Date.parse(h.receivedAt)) <= windowMs,
  );
  if (sameShipment) return { duplicate: true, kind: 'same_shipment', original: sameShipment };

  return { duplicate: false };
}
