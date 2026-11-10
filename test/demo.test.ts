// Runs the whole demo inbox, exactly as `npm run demo` does, and checks the
// result of every email. If a change breaks the demo, this test says which email.

import { describe, expect, it } from 'vitest';
import { loadInbox } from '../src/domain/load-emails.ts';
import { DemoExtractor } from '../src/extraction/demo-extractor.ts';
import { processInbox } from '../src/pipeline/process.ts';

const inbox = loadInbox('data/demo/emails');
const extractor = DemoExtractor.fromFolders(
  new Map(inbox.map((e) => [e.email.messageId, e.name])),
  'data/demo/recorded',
);
const results = await processInbox(
  inbox.map((e) => e.email),
  extractor,
);
const byName = new Map(inbox.map((e, i) => [e.name, results[i]!]));
const get = (name: string) => {
  const r = byName.get(name);
  if (!r) throw new Error(`No demo email ${name}`);
  return r;
};
const flags = (name: string) => get(name).assessment?.flags.map((f) => f.code) ?? [];

describe('demo inbox', () => {
  it('has the 10 emails of the brief, all with fictional .test addresses', () => {
    expect(inbox).toHaveLength(10);
    for (const e of inbox) expect(e.email.from).toMatch(/\.test$/);
  });

  it.each([
    ['01-gru-mia-pallets', 'quote', false, 270_600],
    ['02-inches-mia-gru', 'quote', false, 183_264],
    ['03-pounds-gru-jfk', 'quote', false, 49_500],
    ['04-missing-weight', 'ask_for_info', true, null],
    ['05-lithium-batteries', 'quote', true, 42_075],
    ['06-airport-full-name', 'quote', false, 202_000],
    ['07-duplicate-resend', 'duplicate', true, null],
    ['08-mixed-pieces', 'quote', false, 128_250],
    ['09-urgent-aog', 'quote', false, 23_040],
    ['10-not-a-quote', 'not_a_quote', true, null],
  ] as const)('%s -> %s (review: %s)', (name, outcome, review, totalCents) => {
    const a = get(name).assessment!;
    expect(a.outcome).toBe(outcome);
    expect(a.needsReview).toBe(review);
    expect(a.quote?.totalCents ?? null).toBe(totalCents);
  });

  it('covers each hard case from the brief', () => {
    expect(get('02-inches-mia-gru').assessment?.quote?.weight.pieces[0]?.input.unit).toBe('in');
    expect(get('03-pounds-gru-jfk').assessment?.quote?.weight.weightInput.unit).toBe('lb');
    expect(get('04-missing-weight').assessment?.missingFields).toEqual(['weight']);
    expect(flags('05-lithium-batteries')).toContain('dangerous_goods');
    expect(get('06-airport-full-name').assessment?.origin?.iata).toBe('GRU');
    expect(get('04-missing-weight').assessment?.flags.find((f) => f.code === 'low_confidence')?.message).toBe(
      'AI is not sure about: cargoType 70%',
    );
    expect(get('07-duplicate-resend').assessment?.duplicateOf).toBe('REQ-006');
    expect(get('08-mixed-pieces').extraction?.pieces).toHaveLength(3);
    expect(get('09-urgent-aog').assessment?.priority).toBe('urgent');
    expect(get('09-urgent-aog').assessment?.assumptions[0]).toBe(
      'Quoted to GRU; if the cargo goes to Viracopos (VCP), let us know.',
    );
  });

  it('shows the retry path: the cut-off answer for email 08 is retried', () => {
    expect(get('08-mixed-pieces').ai.attempts.map((a) => a.ok)).toEqual([false, true]);
  });

  it('records tokens and cost for every email', () => {
    for (const r of results) {
      expect(r.ai.model).toBe('claude-haiku-5-5');
      expect(r.ai.inputTokens).toBeGreaterThan(0);
      expect(r.ai.costUsd).toBeGreaterThan(0);
    }
  });
});
