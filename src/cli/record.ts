// Records real AI answers for the demo emails, using the API key in .env.
//   npm run record             reading: calls the API once per email, saves to data/demo/recorded-live/
//                              and compares with the current recordings (nothing is replaced)
//   npm run record -- --write  copies those live reading recordings over the current ones
//   npm run record -- --drafts writing: records the reply text for every email that gets a
//                              draft, straight into data/demo/recorded/drafts, and prints the drafts
// Attempts marked "synthetic" in the current recordings (the cut-off answer
// that demonstrates a retry) are kept in front of the real ones.

import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelCaller, RawAttempt } from '../ai/call.ts';
import { loadApiKey } from '../ai/live.ts';
import { readRecording } from '../ai/recorded.ts';
import { loadInbox } from '../domain/load-emails.ts';
import { liveDraftWriter, type DraftContext } from '../drafting/text.ts';
import { extractWithRetry, liveExtractor } from '../extraction/extract.ts';
import { processInbox, type ProcessedRequest } from '../pipeline/process.ts';
import { demoCallers, namesByMessageId, RECORDED } from './callers.ts';

const LIVE = { extraction: 'data/demo/recorded-live/extraction', drafts: RECORDED.drafts };
const args = new Set(process.argv.slice(2));
const today = new Date().toISOString().slice(0, 10);
const inbox = loadInbox('data/demo/emails');
const names = namesByMessageId(inbox);

if (args.has('--write')) {
  if (!existsSync(LIVE.extraction)) throw new Error('Nothing to write: run "npm run record" first');
  cpSync(LIVE.extraction, RECORDED.extraction, { recursive: true });
  console.log(`Copied ${LIVE.extraction} over ${RECORDED.extraction}. Run "npm test" and "npm run demo" to check.`);
  process.exit(0);
}

const apiKey = loadApiKey();
if (!apiKey) {
  console.error('No ANTHROPIC_API_KEY in .env. Copy .env.example to .env and add a key.');
  process.exit(1);
}

/** Wraps a live caller and keeps every raw answer, good or bad, per input. */
function capturing<I>(inner: ModelCaller<I>, keyOf: (input: I) => string) {
  const log = new Map<string, RawAttempt[]>();
  const caller: ModelCaller<I> = {
    mode: inner.mode,
    attempt: async (input, n) => {
      const raw = await inner.attempt(input, n);
      const key = keyOf(input);
      log.set(key, [...(log.get(key) ?? []), raw]);
      return raw;
    },
  };
  return { caller, log };
}

function saveRecording(file: string, model: string, raws: RawAttempt[]) {
  const synthetic = readRecording(file)?.attempts.filter((a) => a.synthetic) ?? [];
  const attempts = raws.map((raw) => {
    let output: unknown;
    try {
      output = JSON.parse(raw.output);
    } catch {
      output = undefined;
    }
    return {
      stopReason: raw.stopReason,
      usage: { input_tokens: raw.usage.inputTokens, output_tokens: raw.usage.outputTokens },
      ...(output === undefined ? { outputText: raw.output } : { output }),
    };
  });
  const note =
    `Recorded from the live API on ${today} by npm run record.` +
    (synthetic.length ? ' Attempts marked synthetic were written by hand to demonstrate the retry path.' : '');
  writeFileSync(file, JSON.stringify({ note, model, attempts: [...synthetic, ...attempts] }, null, 2) + '\n');
}

if (args.has('--drafts')) {
  // Reading comes from the current recordings; only the reply text is live.
  const writer = liveDraftWriter(apiKey);
  const { caller, log } = capturing<DraftContext>(writer, (c) => c.messageId);
  const callers = { ...demoCallers(inbox), writer: caller };
  console.log(`Recording reply text with ${writer.model}...`);
  const results = await processInbox(inbox.map((e) => e.email), callers);
  mkdirSync(LIVE.drafts, { recursive: true });
  for (const r of results) {
    const name = names.get(r.email.messageId)!;
    const raws = log.get(r.email.messageId);
    if (!raws) {
      console.log(`\n== ${name}: no draft (${r.assessment?.outcome ?? r.status})`);
      continue;
    }
    saveRecording(join(LIVE.drafts, `${name}.json`), writer.model, raws);
    console.log(`\n== ${name}: ${raws.length} call(s), text by ${r.draft?.textSource}`);
    for (const w of r.draft?.warnings ?? []) console.log(`   [warning] ${w}`);
    console.log(r.draft!.body.replace(/^/gm, '   | '));
  }
  process.exit(0);
}

// Reading: record live answers, then compare with the current recordings.
const live = liveExtractor(apiKey);
const { caller, log } = capturing(live, (e) => e.messageId);
mkdirSync(LIVE.extraction, { recursive: true });
console.log(`Recording ${inbox.length} emails with ${live.model}...`);
for (const entry of inbox) {
  const result = await extractWithRetry(caller, entry.email);
  const raws = log.get(entry.email.messageId) ?? [];
  const file = join(LIVE.extraction, `${entry.name}.json`);
  const current = join(RECORDED.extraction, `${entry.name}.json`);
  if (existsSync(current)) cpSync(current, file); // so synthetic attempts carry over
  saveRecording(file, live.model, raws);
  const status = result.ok ? 'ok' : `FAILED: ${result.error}`;
  console.log(`  ${entry.name}: ${raws.length} call(s), ${result.ai.inputTokens} in + ${result.ai.outputTokens} out, ${status}`);
}

const run = (dir: string) => processInbox(inbox.map((e) => e.email), demoCallers(inbox, { ...RECORDED, extraction: dir }));
const [before, after] = await Promise.all([run(RECORDED.extraction), run(LIVE.extraction)]);

const FIELDS = ['isQuoteRequest', 'origin', 'destination', 'pieces', 'weight', 'cargoType', 'cargoDescription', 'readyDate', 'urgent', 'sender'] as const;
const summary = (r: ProcessedRequest) =>
  r.status === 'error'
    ? `ERROR (${r.error})`
    : `${r.assessment!.outcome}${r.assessment!.quote ? ` ${r.assessment!.quote.totalCents / 100}` : ''}${r.assessment!.needsReview ? ' +review' : ''}`;

console.log('\nCOMPARISON: current recordings vs live answers');
let differences = 0;
inbox.forEach((entry, i) => {
  const a = before[i]!;
  const b = after[i]!;
  const lines: string[] = [];
  for (const f of FIELDS) {
    const x = JSON.stringify(a.extraction?.[f] ?? null);
    const y = JSON.stringify(b.extraction?.[f] ?? null);
    if (x !== y) lines.push(`    ${f}: ${x}  ->  ${y}`);
  }
  const flagsA = a.assessment?.flags.map((f) => f.code).join(',') ?? '';
  const flagsB = b.assessment?.flags.map((f) => f.code).join(',') ?? '';
  if (summary(a) !== summary(b)) lines.push(`    OUTCOME: ${summary(a)}  ->  ${summary(b)}`);
  if (flagsA !== flagsB) lines.push(`    flags: [${flagsA}]  ->  [${flagsB}]`);
  if (lines.length) {
    differences++;
    console.log(`  ${entry.name}`);
    for (const l of lines) console.log(l);
  } else {
    console.log(`  ${entry.name}: same result`);
  }
});
const cost = (rs: ProcessedRequest[]) => rs.reduce((s, r) => s + r.ai.costUsd, 0);
console.log(`\n${differences} email(s) differ. Reading cost for the 10 emails: current US$ ${cost(before).toFixed(5)}, live US$ ${cost(after).toFixed(5)}`);
console.log('Nothing was replaced. To use the live recordings: npm run record -- --write');
