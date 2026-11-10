// The price breakdown as the customer sees it. Built only by code, from the
// Quote: the AI never writes or touches these numbers.

import type { Extraction } from '../domain/extraction.ts';
import type { Quote } from '../pricing/quote.ts';

const num = (n: number, decimals: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
const kg = (n: number) => `${num(n, 1)} kg`;
/** Up to 2 decimals, without trailing zeros: 121.92, 101.6, 120. */
const short = (n: number) => num(n, 2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');

export function describeCargo(x: Pick<Extraction, 'cargoType' | 'cargoDescription'>): string {
  // "Auto parts, general cargo" -> "Auto parts"; "general cargo" alone adds nothing.
  const description = x.cargoDescription?.replace(/[,;\s]*\bgeneral cargo\b[.,;\s]*/gi, ' ').trim();
  const what = description ? ` (${description})` : '';
  switch (x.cargoType) {
    case 'dangerous':
      return `Dangerous goods${what}`;
    case 'perishable':
      return `Perishable cargo${what}`;
    case 'general':
      return `General cargo${what}`;
    default:
      return `General cargo (assumed)${what}`;
  }
}

export function customerPriceBlock(q: Quote, x: Extraction): string {
  const w = q.weight;
  const label = (s: string) => s.padEnd(20);
  const lines: string[] = [];

  lines.push(`${label('Route:')}${q.origin} -> ${q.destination}, airport to airport`);
  lines.push(`${label('Cargo:')}${describeCargo(x)}`);
  w.pieces.forEach((p, i) => {
    const inp = p.input;
    const cm = `${short(p.lengthCm)} x ${short(p.widthCm)} x ${short(p.heightCm)} cm`;
    const dims = inp.unit === 'in' ? `${short(inp.length)} x ${short(inp.width)} x ${short(inp.height)} in (${cm})` : cm;
    lines.push(`${label(i === 0 ? 'Pieces:' : '')}${p.count} x ${dims}`);
  });
  const given = w.weightInput.unit === 'lb' ? `${short(w.weightInput.value)} lb (${kg(w.actualKg)})` : kg(w.actualKg);
  lines.push(`${label('Actual weight:')}${given}`);
  lines.push(`${label('Volumetric weight:')}${kg(w.volumetricKg)} (${num(w.totalVolumeCm3, 0)} cm3 / 6000)`);
  lines.push(`${label('Chargeable weight:')}${kg(w.chargeableKg)}`);
  if (x.readyDate) lines.push(`${label('Cargo ready:')}${x.readyDate}`);
  lines.push('');

  const money = (cents: number) => `${q.currency} ${num(cents / 100, 2).padStart(9)}`;
  const row = (what: string, calc: string, cents: number) => `${what.padEnd(30)}${calc.padEnd(20)}${money(cents)}`;
  const f = q.freight;
  if (f.minimumApplied) {
    lines.push(row('Air freight (minimum charge)', '', f.amountCents));
  } else if (f.higherBreakUsed) {
    lines.push(row(`Air freight (${f.breakLabel} rate, min ${f.billedKg} kg)`, `${kg(f.billedKg)} x ${num(f.ratePerKg, 2)}`, f.amountCents));
  } else {
    lines.push(row(`Air freight (${f.breakLabel} rate)`, `${kg(f.billedKg)} x ${num(f.ratePerKg, 2)}`, f.amountCents));
  }
  for (const s of q.surcharges) lines.push(row(s.name, `${kg(s.kg)} x ${num(s.ratePerKg, 2)}`, s.amountCents));
  lines.push(`${''.padEnd(50)}${'-'.repeat(13)}`);
  lines.push(row('Total', '', q.totalCents));
  return lines.join('\n');
}

/** What we already know, so the customer only has to fill the gaps. Airports already read are shown as codes. */
export function knownSoFar(x: Extraction, resolved: { origin?: string; destination?: string } = {}): string[] {
  const out: string[] = [];
  if (x.origin || x.destination) {
    out.push(`Route: ${resolved.origin ?? x.origin ?? '?'} -> ${resolved.destination ?? x.destination ?? '?'}`);
  }
  if (x.pieces) {
    out.push(`Pieces: ${x.pieces.map((p) => `${p.count} x ${short(p.length)} x ${short(p.width)} x ${short(p.height)} ${p.unit}`).join(', ')}`);
  }
  if (x.weight) out.push(`Weight: ${short(x.weight.value)} ${x.weight.unit}${x.weight.per === 'piece' ? ' per piece' : ' total'}`);
  if (x.cargoType || x.cargoDescription) out.push(`Cargo: ${describeCargo(x)}`);
  if (x.readyDate) out.push(`Cargo ready: ${x.readyDate}`);
  return out;
}
