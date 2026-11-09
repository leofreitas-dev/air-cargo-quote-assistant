// Turns a Quote into a readable step-by-step breakdown.
// Reused later as the price block inside the reply draft.

import type { Quote } from './quote.ts';
import { VOLUMETRIC_DIVISOR } from './chargeable-weight.ts';

const num = (n: number, decimals = 0) =>
  n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
const kg = (n: number) => `${num(n, 1)} kg`;
const money = (cents: number) => num(cents / 100, 2);
/** Up to 2 decimals, without trailing zeros: 121.92, 101.6, 120. */
const short = (n: number) => num(n, 2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');

/** One charge line: label on the left, calculation in the middle, amount on the right. */
const row = (label: string, calc: string, cents: number) =>
  `${label.padEnd(26)}${calc.padEnd(26)}${money(cents).padStart(12)}`;

export function formatQuote(q: Quote): string {
  const w = q.weight;
  const lines: string[] = [`${q.origin} -> ${q.destination}   (${q.tariffName}, ${q.currency})`, '', 'Pieces'];

  for (const p of w.pieces) {
    const i = p.input;
    const inCm = `${short(p.lengthCm)} x ${short(p.widthCm)} x ${short(p.heightCm)} cm`;
    const given = i.unit === 'cm' ? '' : `   (given as ${short(i.length)} x ${short(i.width)} x ${short(i.height)} in)`;
    lines.push(`  ${p.count} x ${inCm} = ${num(p.volumeCm3)} cm3${given}`);
  }

  const actualGiven = w.weightInput.unit === 'kg' ? '' : `   (given as ${short(w.weightInput.value)} lb)`;
  const maxKg = Math.max(w.actualKg, w.volumetricKg);
  const rounded = w.chargeableKg !== maxKg ? `, rounded up from ${num(maxKg, 2)}` : '';
  lines.push(
    '',
    `Volumetric weight: ${num(w.totalVolumeCm3)} cm3 / ${VOLUMETRIC_DIVISOR} = ${num(w.volumetricKg, 2)} kg`,
    `Actual weight:     ${num(w.actualKg, 2)} kg${actualGiven}`,
    `Chargeable weight: ${kg(w.chargeableKg)}  (${w.basis} is higher${rounded})`,
    '',
  );

  const f = q.freight;
  const freightCalc = f.minimumApplied ? 'route minimum' : `${kg(f.billedKg)} x ${num(f.ratePerKg, 2)}`;
  lines.push(row(`Freight, ${f.breakLabel} rate`, freightCalc, f.amountCents));
  if (f.higherBreakUsed) {
    lines.push(`  (billed as ${kg(f.billedKg)}: the ${f.breakLabel} rate costs less than the normal rate)`);
  }
  if (f.minimumApplied) {
    lines.push(`  (${kg(f.billedKg)} x ${num(f.ratePerKg, 2)} is below the route minimum)`);
  }
  for (const s of q.surcharges) {
    lines.push(row(`${s.name} (${s.code})`, `${kg(s.kg)} x ${num(s.ratePerKg, 2)}`, s.amountCents));
  }
  lines.push('-'.repeat(64), row(`TOTAL ${q.currency}`, '', q.totalCents));
  return lines.join('\n');
}
