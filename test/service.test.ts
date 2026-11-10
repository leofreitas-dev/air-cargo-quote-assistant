import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ActionError, QuoteService } from '../src/app/service.ts';
import { demoCallers } from '../src/cli/callers.ts';
import { loadInbox } from '../src/domain/load-emails.ts';
import { Store } from '../src/store/db.ts';

const inbox = loadInbox('data/demo/emails');
const email = (name: string) => inbox.find((e) => e.name === name)!.email;

let service: QuoteService;
let outbox: string;
let clock: number;

beforeEach(() => {
  outbox = mkdtempSync(join(tmpdir(), 'outbox-'));
  clock = Date.parse('2026-11-10T15:00:00Z');
  service = new QuoteService(new Store(':memory:'), demoCallers(inbox), {
    outboxDir: outbox,
    now: () => new Date((clock += 60_000)), // one minute per step
  });
});

describe('ingest', () => {
  it('processes an email and puts it in the approval queue with a draft', async () => {
    const { request, created } = await service.ingest(email('01-gru-mia-pallets'));
    expect(created).toBe(true);
    expect(request).toMatchObject({ id: 'REQ-001', status: 'pending', outcome: 'quote', needsReview: false });
    expect(request.draft?.body).toMatch(/Total\s+USD\s+2,706\.00/);
    expect(service.store.events('REQ-001').map((e) => e.type)).toEqual(['received', 'extracted', 'assessed', 'drafted']);
  });

  it('does not process the same email twice (same Message-ID)', async () => {
    await service.ingest(email('01-gru-mia-pallets'));
    const again = await service.ingest(email('01-gru-mia-pallets'));
    expect(again.created).toBe(false);
    expect(again.request.id).toBe('REQ-001');
    expect(service.store.list()).toHaveLength(1);
    expect(service.store.events('REQ-001').at(-1)?.type).toBe('duplicate_delivery');
  });

  it('detects the same shipment sent again in a new email, using the stored history', async () => {
    await service.ingest(email('06-airport-full-name'));
    const { request } = await service.ingest(email('07-duplicate-resend'));
    expect(request.outcome).toBe('duplicate');
    expect(request.assessment?.duplicateOf).toBe('REQ-001');
    expect(request.draft).toBeNull();
  });

  it('puts an email the AI cannot read in the error queue, and can retry it', async () => {
    const stranger = { ...email('01-gru-mia-pallets'), messageId: '<no-recording@mail.test>' };
    const { request } = await service.ingest(stranger);
    expect(request.status).toBe('error');
    expect(request.error).toMatch(/^Extraction failed after 3 attempts/);
    await expect(service.retry('REQ-001')).resolves.toMatchObject({ status: 'error' });
    expect(service.store.events('REQ-001').map((e) => e.type)).toEqual(['received', 'extraction_failed', 'retried', 'extraction_failed']);
    expect(service.close('REQ-001', 'spam').status).toBe('closed');
  });
});

describe('approve', () => {
  it('writes the reply to the outbox and records the decision', async () => {
    await service.ingest(email('01-gru-mia-pallets'));
    const r = service.approve('REQ-001');
    expect(r).toMatchObject({ status: 'approved', decisionNote: 'approved as drafted' });
    const eml = readFileSync(join(outbox, 'REQ-001.eml'), 'utf8');
    expect(eml).toContain('To: ana.ribeiro@andorinha-logistica.test');
    expect(eml).toContain('Subject: RE: Quote request GRU-MIA, 3 pallets');
    expect(eml).toContain('In-Reply-To: <20261109.0901.a1@andorinha-logistica.test>');
    expect(eml).toMatch(/Total\s+USD\s+2,706\.00/);
  });

  it('requires the approver to confirm the review reasons first', async () => {
    await service.ingest(email('05-lithium-batteries'));
    expect(() => service.approve('REQ-001')).toThrow(/confirm you checked the reasons/);
    expect(service.approve('REQ-001', { reviewConfirmed: true }).status).toBe('approved');
  });

  it('sends the edited text when the approver changed it', async () => {
    await service.ingest(email('01-gru-mia-pallets'));
    const draft = service.store.get('REQ-001')!.draft!.body;
    service.saveEdit('REQ-001', draft.replace('Hello Ana,', 'Hi Ana,'));
    const r = service.approve('REQ-001');
    expect(r.decisionNote).toBe('approved with edits');
    expect(readFileSync(join(outbox, 'REQ-001.eml'), 'utf8')).toContain('Hi Ana,');
    expect(service.store.events('REQ-001').filter((e) => e.type === 'edited')).toHaveLength(1);
  });

  it('never approves twice, approves nothing without a draft, and refuses an empty reply', async () => {
    await service.ingest(email('01-gru-mia-pallets'));
    await service.ingest(email('10-not-a-quote'));
    service.approve('REQ-001');
    expect(() => service.approve('REQ-001')).toThrow('REQ-001 is already approved');
    expect(() => service.approve('REQ-002', { reviewConfirmed: true })).toThrow(/no draft to approve/);
    expect(() => service.approve('REQ-404')).toThrow(ActionError);
  });

  it('keeps email headers on one line, even if the subject tries to add a header', async () => {
    const tricky = { ...email('01-gru-mia-pallets'), subject: 'Quote\r\nBcc: someone@example.test' };
    await service.ingest(tricky);
    service.approve('REQ-001');
    const eml = readFileSync(join(outbox, 'REQ-001.eml'), 'utf8');
    expect(eml).not.toMatch(/^Bcc:/m);
    expect(eml).toContain('Subject: RE: Quote Bcc: someone@example.test');
  });
});

describe('reject and close', () => {
  it('rejects with a reason and writes nothing to the outbox', async () => {
    await service.ingest(email('01-gru-mia-pallets'));
    expect(() => service.reject('REQ-001', '  ')).toThrow(/Say why/);
    const r = service.reject('REQ-001', 'Customer already booked elsewhere');
    expect(r).toMatchObject({ status: 'rejected', decisionNote: 'Customer already booked elsewhere', outboxFile: null });
  });

  it('closes a request that needs no reply', async () => {
    await service.ingest(email('10-not-a-quote'));
    expect(service.close('REQ-001', '').decisionNote).toBe('closed without reply');
  });

  it('records the time from arrival to decision', async () => {
    await service.ingest(email('01-gru-mia-pallets'));
    const r = service.approve('REQ-001');
    expect(Date.parse(r.decidedAt!) - Date.parse(r.createdAt)).toBeGreaterThan(0);
  });
});
