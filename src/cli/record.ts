// Records real AI answers for the demo emails, using the API key in .env.
//   npm run record            -> calls the API once per email, saves to data/demo/recorded-live/
//                                and compares with data/demo/recorded/ (nothing is replaced)
//   npm run record -- --write -> copies the live recordings over data/demo/recorded/
// Attempts marked "synthetic" in the current recordings (the cut-off answer
// that demonstrates a retry) are kept in front of the real ones.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadInbox, type InboxEntry } from '../domain/load-emails.ts';
import { DemoExtractor, RecordingSchema } from '../extraction/demo-extractor.ts';
import { extractWithRetry, type Extractor, type RawAttempt } from '../extraction/extract.ts';
import { LiveExtractor, loadApiKey } from '../extraction/live-extractor.ts';
import { processInbox, type ProcessedRequest } from '../pipeline/process.ts';

const EMAILS = 'data/demo/emails';
const CURRENT = 'data/demo/recorded';
const LIVE = 'data/demo/recorded-live';

if (process.argv.includes('--write')) {
  if (!existsSync(LIVE)) throw new Error(`Nothing to write: run "npm run record" first`);
  cpSync(LIVE, CURRENT, { recursive: true });
  console.log(`Copied ${LIVE} over ${CURRENT}. Run "npm test" and "npm run demo" to check.`);
  process.exit(0);
}

const apiKey = loadApiKey();
if (!apiKey) {
  console.error('No ANTHROPIC_API_KEY in .env. Copy .env.example to .env and add a key.');
  process.exit(1);
}

/** Wraps the live extractor and keeps every raw answer, good or bad. */
function capturing(inner: Extractor): Extractor & { log: RawAttempt[] } {
  const log: RawAttempt[] = [];
  return { mode: inner.mode, log, attempt: async (e, n) => {
    const raw = await inner.attempt(e, n);
    log.push(raw);
    return raw;
  } };
}

function toRecordedAttempt(raw: RawAttempt) {
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
}

const inbox = loadInbox(EMAILS);
const live = new LiveExtractor({ apiKey });
mkdirSync(LIVE, { recursive: true });
const today = new Date().toISOString().slice(0, 10);

console.log(`Recording ${inbox.length} emails with ${live.model}...`);
for (const entry of inbox) {
  const cap = capturing(live);
  const result = await extractWithRetry(cap, entry.email);
  const currentFile = join(CURRENT, `${entry.name}.json`);
  const synthetic = existsSync(currentFile)
    ? RecordingSchema.parse(JSON.parse(readFileSync(currentFile, 'utf8'))).attempts.filter((a) => a.synthetic)
    : [];
  const recording = {
    note:
      `Recorded from the live API on ${today} by npm run record.` +
      (synthetic.length ? ' Attempts marked synthetic were written by hand to demonstrate the retry path.' : ''),
    model: result.ai.model ?? live.model,
    attempts: [...synthetic, ...cap.log.map(toRecordedAttempt)],
  };
  writeFileSync(join(LIVE, `${entry.name}.json`), JSON.stringify(recording, null, 2) + '\n');
  const status = result.ok ? 'ok' : `FAILED: ${result.error}`;
  console.log(`  ${entry.name}: ${cap.log.length} call(s), ${result.ai.inputTokens} in + ${result.ai.outputTokens} out, ${status}`);
}

// Compare: run the whole pipeline on both sets of recordings.
const run = (dir: string) =>
  processInbox(
    inbox.map((e) => e.email),
    DemoExtractor.fromFolders(new Map(inbox.map((e) => [e.email.messageId, e.name])), dir),
  );
const [before, after] = await Promise.all([run(CURRENT), run(LIVE)]);

const FIELDS = ['isQuoteRequest', 'origin', 'destination', 'pieces', 'weight', 'cargoType', 'cargoDescription', 'readyDate', 'urgent', 'sender'] as const;
const summary = (r: ProcessedRequest) =>
  r.status === 'error'
    ? `ERROR (${r.error})`
    : `${r.assessment!.outcome}${r.assessment!.quote ? ` ${r.assessment!.quote.totalCents / 100}` : ''}${r.assessment!.needsReview ? ' +review' : ''}`;

console.log('\nCOMPARISON: hand-written recordings vs live answers');
let differences = 0;
inbox.forEach((entry: InboxEntry, i) => {
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
console.log(`\n${differences} email(s) differ. AI cost for the 10 emails: hand-written US$ ${cost(before).toFixed(5)}, live US$ ${cost(after).toFixed(5)}`);
console.log(`Nothing was replaced. To use the live recordings: npm run record -- --write`);
