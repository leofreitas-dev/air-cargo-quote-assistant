// Runs the 10 demo emails through the pipeline.
// Usage: npm run demo              recorded AI answers, no API key needed
//        npm run demo -- --details plus each price breakdown
//        npm run demo -- --live    real AI answers (needs ANTHROPIC_API_KEY in .env, costs under 1 US cent)

import { DemoExtractor } from '../extraction/demo-extractor.ts';
import type { Extractor } from '../extraction/extract.ts';
import { LiveExtractor, loadApiKey } from '../extraction/live-extractor.ts';
import { loadInbox } from '../domain/load-emails.ts';
import { processInbox, type ProcessedRequest } from '../pipeline/process.ts';
import { formatQuote } from '../pricing/format.ts';

const EMAILS_DIR = 'data/demo/emails';
const RECORDED_DIR = 'data/demo/recorded';
const showDetails = process.argv.includes('--details');
const liveMode = process.argv.includes('--live');

const money = (cents: number) => (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
const usd = (n: number, decimals = 5) => `US$ ${n.toFixed(decimals)}`;
const int = (n: number) => n.toLocaleString('en-US');

function describe(r: ProcessedRequest): string[] {
  const lines: string[] = [];
  const x = r.extraction;
  if (x && x.isQuoteRequest) {
    const pieces = x.pieces?.map((p) => `${p.count} x ${p.length}x${p.width}x${p.height} ${p.unit}`).join(' + ') ?? '?';
    const weight = x.weight ? `${x.weight.value} ${x.weight.unit} ${x.weight.per}` : '? kg';
    lines.push(
      `  Extracted: ${x.origin ?? '?'} -> ${x.destination ?? '?'} | ${pieces} | ${weight} | ` +
        `${x.cargoType ?? 'type?'} | ready ${x.readyDate ?? '?'}`,
    );
  }

  if (r.status === 'error') {
    lines.push(`  Outcome:   ERROR QUEUE  ${r.error}`);
  } else {
    const a = r.assessment!;
    let outcome = a.outcome.toUpperCase().replaceAll('_', ' ');
    if (a.quote) outcome += `  ${a.quote.currency} ${money(a.quote.totalCents)} (chargeable ${a.quote.weight.chargeableKg} kg)`;
    if (a.priority === 'urgent') outcome += '  [URGENT]';
    lines.push(`  Outcome:   ${outcome}${a.needsReview ? '  -> NEEDS REVIEW' : ''}`);
    for (const f of a.flags) lines.push(`             ${f.severity === 'review' ? '[review]' : '[info]  '} ${f.message}`);
    for (const s of a.assumptions) lines.push(`             [reply says] ${s}`);
  }

  const ai = r.ai;
  const attempts = ai.attempts
    .map((t) => (t.ok ? `#${t.attempt} ok` : `#${t.attempt} rejected (${t.error})`))
    .join(', ');
  lines.push(
    `  AI:        ${ai.model ?? 'n/a'} | ${attempts} | ${int(ai.inputTokens)} in + ${int(ai.outputTokens)} out tokens | ${usd(ai.costUsd)}`,
  );
  return lines;
}

const inbox = loadInbox(EMAILS_DIR);
let extractor: Extractor;
if (liveMode) {
  const apiKey = loadApiKey();
  if (!apiKey) {
    console.error('Live mode needs ANTHROPIC_API_KEY in .env (see .env.example). Without it, run: npm run demo');
    process.exit(1);
  }
  extractor = new LiveExtractor({ apiKey });
} else {
  extractor = DemoExtractor.fromFolders(new Map(inbox.map((e) => [e.email.messageId, e.name])), RECORDED_DIR);
}
const results = await processInbox(
  inbox.map((e) => e.email),
  extractor,
);

console.log(
  liveMode
    ? 'LIVE MODE: each email is read by the real AI (API key from .env)\n'
    : `DEMO MODE: AI answers come from ${RECORDED_DIR} (no API key used)\n`,
);
for (const [i, r] of results.entries()) {
  console.log(`${r.id}  ${inbox[i]!.name}  <${r.email.from}>`);
  console.log(`  Subject:   ${r.email.subject}`);
  for (const line of describe(r)) console.log(line);
  if (showDetails && r.assessment?.quote) {
    console.log('\n' + formatQuote(r.assessment.quote).replace(/^/gm, '    ') + '\n');
  }
  console.log('');
}

// Summary
const count = (pred: (r: ProcessedRequest) => boolean) => results.filter(pred).length;
const byOutcome = new Map<string, number>();
for (const r of results) {
  const key = r.status === 'error' ? 'error queue' : r.assessment!.outcome.replaceAll('_', ' ');
  byOutcome.set(key, (byOutcome.get(key) ?? 0) + 1);
}
const tokensIn = results.reduce((s, r) => s + r.ai.inputTokens, 0);
const tokensOut = results.reduce((s, r) => s + r.ai.outputTokens, 0);
const cost = results.reduce((s, r) => s + r.ai.costUsd, 0);
const retried = count((r) => r.ai.attempts.length > 1);

console.log('SUMMARY');
console.log(`  Emails:        ${results.length}`);
console.log(`  Outcomes:      ${[...byOutcome].map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`  Needs review:  ${count((r) => r.assessment?.needsReview === true)} (every reply still waits for approval)`);
console.log(`  AI retries:    ${retried} email(s) needed more than one attempt`);
console.log(`  AI usage:      ${int(tokensIn)} input + ${int(tokensOut)} output tokens`);
console.log(`  AI cost:       ${usd(cost)} total, ${usd(cost / results.length)} per email, about ${usd((cost / results.length) * 1000, 2)} per 1,000 emails`);
