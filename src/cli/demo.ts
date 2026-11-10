// Runs the 10 demo emails through the pipeline.
// Usage: npm run demo              recorded AI answers, no API key needed
//        npm run demo -- --drafts  plus the full reply draft of each email
//        npm run demo -- --details plus the internal price breakdown
//        npm run demo -- --live    real AI answers (needs ANTHROPIC_API_KEY in .env, costs about 1 US cent)

import { loadApiKey } from '../ai/live.ts';
import { loadInbox } from '../domain/load-emails.ts';
import { processInbox, requestAiTotals, type ProcessedRequest } from '../pipeline/process.ts';
import { formatQuote } from '../pricing/format.ts';
import { demoCallers, liveCallers, RECORDED } from './callers.ts';

const args = new Set(process.argv.slice(2));
const showDetails = args.has('--details');
const showDrafts = args.has('--drafts');
const liveMode = args.has('--live');

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
  }

  const d = r.draft;
  lines.push(
    d
      ? `  Draft:     ${d.kind.replaceAll('_', ' ')} reply to ${d.to} (text by ${d.textSource === 'ai' ? 'AI' : 'TEMPLATE'})` +
          d.warnings.map((w) => `\n             [warning] ${w}`).join('')
      : `  Draft:     none, a person decides`,
  );

  const attempts = (ai: ProcessedRequest['ai']) =>
    ai.attempts.map((t) => (t.ok ? `#${t.attempt} ok` : `#${t.attempt} rejected (${t.error})`)).join(', ');
  const t = requestAiTotals(r);
  lines.push(`  AI:        read ${attempts(r.ai)}${d?.ai ? ` | write ${attempts(d.ai)}` : ''}`);
  lines.push(`             ${int(t.inputTokens)} in + ${int(t.outputTokens)} out tokens | ${usd(t.costUsd)} (${r.ai.model ?? 'n/a'})`);
  return lines;
}

const inbox = loadInbox('data/demo/emails');
let callers;
if (liveMode) {
  const apiKey = loadApiKey();
  if (!apiKey) {
    console.error('Live mode needs ANTHROPIC_API_KEY in .env (see .env.example). Without it, run: npm run demo');
    process.exit(1);
  }
  callers = liveCallers(apiKey);
} else {
  callers = demoCallers(inbox);
}
const results = await processInbox(
  inbox.map((e) => e.email),
  callers,
);

console.log(
  liveMode
    ? 'LIVE MODE: each email is read and answered by the real AI (API key from .env)\n'
    : `DEMO MODE: AI answers come from ${RECORDED.extraction} and ${RECORDED.drafts} (no API key used)\n`,
);
for (const [i, r] of results.entries()) {
  console.log(`${r.id}  ${inbox[i]!.name}  <${r.email.from}>`);
  console.log(`  Subject:   ${r.email.subject}`);
  for (const line of describe(r)) console.log(line);
  if (showDetails && r.assessment?.quote) console.log('\n' + formatQuote(r.assessment.quote).replace(/^/gm, '    ') + '\n');
  if (showDrafts && r.draft) {
    const box = `To: ${r.draft.to}\nSubject: ${r.draft.subject}\n\n${r.draft.body}`;
    console.log('\n' + box.replace(/^/gm, '    | ') + '\n');
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
const totals = results.map(requestAiTotals);
const tokensIn = totals.reduce((s, t) => s + t.inputTokens, 0);
const tokensOut = totals.reduce((s, t) => s + t.outputTokens, 0);
const cost = totals.reduce((s, t) => s + t.costUsd, 0);
const retried = count((r) => r.ai.attempts.length > 1 || (r.draft?.ai?.attempts.length ?? 0) > 1);

console.log('SUMMARY');
console.log(`  Emails:        ${results.length}`);
console.log(`  Outcomes:      ${[...byOutcome].map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`  Drafts:        ${count((r) => r.draft !== null)} written (${count((r) => r.draft?.textSource === 'template')} from the template), all waiting for approval`);
console.log(`  Needs review:  ${count((r) => r.assessment?.needsReview === true)}`);
console.log(`  AI retries:    ${retried} request(s) needed more than one attempt`);
console.log(`  AI usage:      ${int(tokensIn)} input + ${int(tokensOut)} output tokens (reading + writing)`);
console.log(`  AI cost:       ${usd(cost)} total, ${usd(cost / results.length)} per email, about ${usd((cost / results.length) * 1000, 2)} per 1,000 emails`);
