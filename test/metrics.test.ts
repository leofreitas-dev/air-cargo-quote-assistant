import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { computeMetrics } from '../src/app/metrics.ts';
import { QuoteService } from '../src/app/service.ts';
import { demoCallers } from '../src/cli/callers.ts';
import { loadInbox } from '../src/domain/load-emails.ts';
import { Store } from '../src/store/db.ts';

const inbox = loadInbox('data/demo/emails');
let service: QuoteService;
let clock: number;
const metrics = () => computeMetrics(service.store.list(), service.store.events(), new Date(clock));

beforeEach(async () => {
  clock = Date.parse('2026-11-10T15:00:00Z');
  service = new QuoteService(new Store(':memory:'), demoCallers(inbox), {
    outboxDir: mkdtempSync(join(tmpdir(), 'outbox-')),
    now: () => new Date((clock += 60_000)), // every step takes one minute
  });
  for (const e of inbox) await service.ingest(e.email);
});

describe('computeMetrics', () => {
  it('counts the volume of the demo inbox', () => {
    const m = metrics();
    expect(m.volume.total).toBe(10);
    expect(m.volume.byStatus.pending).toBe(10);
    expect(m.volume.byOutcome).toEqual({ quote: 7, ask_for_info: 1, duplicate: 1, not_a_quote: 1 });
    expect(m.volume.needsReview).toBe(4);
    expect(m.volume.urgent).toBe(1);
  });

  it('measures decisions, edits and time to decision', () => {
    const before = metrics();
    expect(before.decisions.decided).toBe(0);
    expect(before.decisions.medianMinutes).toBeNull();
    expect(before.decisions.oldestPendingMinutes).toBeGreaterThan(0);

    service.approve('REQ-001');
    const body = service.store.get('REQ-002')!.draft!.body.replace('Hello Mike,', 'Hi Mike,');
    service.approve('REQ-002', { body });
    service.reject('REQ-003', 'Customer cancelled');
    service.close('REQ-010', 'Payment confirmation');

    const m = metrics();
    expect(m.decisions).toMatchObject({ decided: 4, approved: 2, approvedAsDrafted: 1, approvedWithEdits: 1, rejected: 1, closed: 1, editRate: 0.5 });
    expect(m.decisions.medianMinutes).toBeGreaterThan(0);
  });

  it('counts problems by type, including AI retries and repeated deliveries', async () => {
    await service.ingest(inbox[0]!.email); // the same email again
    const byCode = Object.fromEntries(metrics().problems.map((p) => [p.code, p.count]));
    expect(byCode).toMatchObject({
      dangerous_goods: 1,
      missing_fields: 1,
      low_confidence: 1,
      duplicate_shipment: 1,
      not_a_quote_request: 1,
      ai_retry: 1, // email 08's cut-off answer
      duplicate_delivery: 1,
    });
    expect(metrics().problems[0]!.label).toBeTypeOf('string');
  });

  it('adds up AI tokens and cost, reading and writing, and what the retries cost', () => {
    const m = metrics();
    expect(m.ai.inputTokens).toBeGreaterThan(20_000);
    expect(m.ai.costUsd).toBeCloseTo(m.ai.readCostUsd + m.ai.writeCostUsd, 10);
    expect(m.ai.costUsd).toBeCloseTo(m.ai.perRequest.reduce((s, r) => s + r.costUsd, 0), 10);
    expect(m.ai.rejectedAttempts).toBe(1);
    expect(m.ai.rejectedAttemptsCostUsd).toBeGreaterThan(0);
    expect(m.ai.rejectedAttemptsCostUsd).toBeLessThan(m.ai.costUsd);
  });

  it('works on an empty database', () => {
    const m = computeMetrics([], []);
    expect(m.volume.total).toBe(0);
    expect(m.ai.costPerRequest).toBeNull();
    expect(m.problems).toEqual([]);
  });
});
