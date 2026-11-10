import { describe, expect, it } from 'vitest';
import type { IncomingEmail } from '../src/domain/email.ts';
import type { RawAttempt } from '../src/ai/call.ts';
import { costUsd } from '../src/ai/cost.ts';
import { templateText, type DraftWriter } from '../src/drafting/text.ts';
import { extractWithRetry, parseAttempt, type Extractor } from '../src/extraction/extract.ts';
import { processEmail } from '../src/pipeline/process.ts';

const email: IncomingEmail = {
  messageId: '<x1@mail.test>',
  from: 'ops@example-forwarder.test',
  subject: 'Quote',
  receivedAt: '2026-11-09T14:00:00Z',
  body: '3 pallets 120x100x110 cm, 420 kg, GRU to MIA',
};

const validOutput = JSON.stringify({
  isQuoteRequest: true,
  origin: 'GRU',
  destination: 'MIA',
  pieces: [{ count: 3, length: 120, width: 100, height: 110, unit: 'cm' }],
  weight: { value: 420, unit: 'kg', per: 'total' },
  cargoType: 'general',
  cargoDescription: null,
  readyDate: '2026-11-13',
  urgent: false,
  sender: { name: null, company: null },
  confidence: { origin: 0.95, destination: 0.95, pieces: 0.95, weight: 0.95, cargoType: 0.95, readyDate: 0.95 },
});

const answer = (output: string, stopReason = 'end_turn'): RawAttempt => ({
  model: 'claude-haiku-5-5',
  output,
  stopReason,
  usage: { inputTokens: 1000, outputTokens: 200 },
});

/** A caller that plays a fixed script: an answer, or an Error to throw. */
function scripted(...steps: (RawAttempt | Error)[]): Extractor & DraftWriter & { calls: number } {
  return {
    mode: 'demo',
    calls: 0,
    async attempt() {
      const step = steps[Math.min(this.calls++, steps.length - 1)]!;
      if (step instanceof Error) throw step;
      return step;
    },
  };
}

describe('costUsd', () => {
  it('uses the Haiku price per million tokens', () => {
    // 1,000,000 in x $0.10 + 1,000,000 out x $0.50
    expect(costUsd('claude-haiku-5-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(0.6, 10);
    expect(costUsd('claude-haiku-5-5', { inputTokens: 1000, outputTokens: 200 })).toBeCloseTo(0.0002, 10);
  });

  it('refuses to guess the price of an unknown model', () => {
    expect(() => costUsd('some-other-model', { inputTokens: 1, outputTokens: 1 })).toThrow(/No price on file/);
  });
});

describe('parseAttempt', () => {
  it('accepts a valid answer', () => {
    expect(parseAttempt(answer(validOutput)).ok).toBe(true);
  });

  it('rejects cut-off, refused, non-JSON and off-format answers with a reason', () => {
    const reason = (raw: RawAttempt) => {
      const r = parseAttempt(raw);
      return r.ok ? 'ok' : r.error;
    };
    expect(reason(answer(validOutput.slice(0, 50), 'max_tokens'))).toMatch(/cut off/);
    expect(reason(answer('', 'refusal'))).toMatch(/declined/);
    expect(reason(answer('Sure! Here is the JSON:'))).toMatch(/not valid JSON/);
    expect(reason(answer(validOutput.replace('"kg"', '"tons"')))).toMatch(/does not match the format: weight.unit/);
  });
});

describe('extractWithRetry', () => {
  it('succeeds on the first attempt and records tokens and cost', async () => {
    const r = await extractWithRetry(scripted(answer(validOutput)), email);
    expect(r.ok && r.value.origin).toBe('GRU');
    expect(r.ai).toMatchObject({ model: 'claude-haiku-5-5', inputTokens: 1000, outputTokens: 200 });
    expect(r.ai.costUsd).toBeCloseTo(0.0002, 10);
  });

  it('retries after a bad answer and counts the tokens of both attempts', async () => {
    const extractor = scripted(answer('{"isQuote', 'max_tokens'), answer(validOutput));
    const r = await extractWithRetry(extractor, email);
    expect(r.ok).toBe(true);
    expect(extractor.calls).toBe(2);
    expect(r.ai.attempts.map((a) => a.ok)).toEqual([false, true]);
    expect(r.ai.inputTokens).toBe(2000);
    expect(r.ai.costUsd).toBeCloseTo(0.0004, 10);
  });

  it('retries when the API call itself fails, without counting tokens', async () => {
    const r = await extractWithRetry(scripted(new Error('connection reset'), answer(validOutput)), email);
    expect(r.ok).toBe(true);
    expect(r.ai.attempts[0]).toMatchObject({ ok: false, error: 'AI call failed: connection reset' });
    expect(r.ai.inputTokens).toBe(1000);
  });

  it('gives up after 3 attempts with the last reason', async () => {
    const extractor = scripted(answer('not json'));
    const r = await extractWithRetry(extractor, email);
    expect(extractor.calls).toBe(3);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe('Extraction failed after 3 attempts. Last error: Answer is not valid JSON');
    expect(r.ai.inputTokens).toBe(3000); // failed attempts still cost money
  });
});

describe('processEmail', () => {
  it('sends an email the AI cannot read to the error queue (brief: AI failure path)', async () => {
    const r = await processEmail('REQ-099', email, { extractor: scripted(new Error('API unavailable')), writer: scripted(new Error('unused')) });
    expect(r.status).toBe('error');
    expect(r.assessment).toBeNull();
    expect(r.error).toBe('Extraction failed after 3 attempts. Last error: AI call failed: API unavailable');
  });

  it('assesses an email the AI read correctly', async () => {
    const text = JSON.stringify(templateText({ messageId: '', kind: 'quote', subject: '', senderName: null, senderCompany: null, route: '', cargo: '', urgent: false, dangerousGoods: false, perishable: false, questionCount: 0 }));
    const r = await processEmail('REQ-001', email, { extractor: scripted(answer(validOutput)), writer: scripted(answer(text)) });
    expect(r.status).toBe('assessed');
    expect(r.assessment?.quote?.totalCents).toBe(270_600);
    expect(r.draft?.textSource).toBe('ai');
  });
});
