import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QuoteService } from '../src/app/service.ts';
import { demoCallers } from '../src/cli/callers.ts';
import { loadInbox } from '../src/domain/load-emails.ts';
import { Store } from '../src/store/db.ts';
import { createAppServer } from '../src/web/server.ts';

const inbox = loadInbox('data/demo/emails');
const service = new QuoteService(new Store(':memory:'), demoCallers(inbox), { outboxDir: mkdtempSync(join(tmpdir(), 'outbox-')) });
const server = createAppServer({ service, mode: 'demo' });
let base = '';

beforeAll(async () => {
  for (const e of inbox) await service.ingest(e.email);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const post = (path: string, form: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch(base + path, {
    method: 'POST',
    body: new URLSearchParams(form),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    redirect: 'manual',
  });
const postJson = (body: unknown) =>
  fetch(`${base}/api/requests`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });

describe('pages', () => {
  it('lists the queue with urgent requests first', async () => {
    const page = await (await fetch(base + '/')).text();
    expect(page).toContain('Waiting for approval (10)');
    expect(page.indexOf('REQ-009')).toBeLessThan(page.indexOf('REQ-001')); // REQ-009 is urgent
  });

  it('shows a request with the review reasons, the extraction, the price and the draft', async () => {
    const page = await (await fetch(base + '/requests/REQ-005')).text();
    expect(page).toContain('Why this needs review');
    expect(page).toContain('Dangerous goods');
    expect(page).toContain('What the AI extracted');
    expect(page).toContain('Price calculation (by code)');
    expect(page).toContain('name="reviewConfirmed"');
    expect(page).toMatch(/Total\s+USD\s+420\.75/);
  });

  it('returns 404 for an unknown request', async () => {
    expect((await fetch(base + '/requests/REQ-999')).status).toBe(404);
  });
});

describe('actions', () => {
  it('refuses to approve a flagged request without the confirmation, then approves with it', async () => {
    const first = await post('/requests/REQ-005/approve', {});
    expect(first.status).toBe(303);
    expect(first.headers.get('location')).toMatch(/err=This\+request\+is\+flagged/);
    const second = await post('/requests/REQ-005/approve', { reviewConfirmed: 'yes' });
    expect(second.headers.get('location')).toMatch(/msg=REQ-005\+approved/);
    expect(service.store.get('REQ-005')?.status).toBe('approved');
  });

  it('saves an edit made in the text box', async () => {
    const body = service.store.get('REQ-001')!.draft!.body.replace('Hello Ana,', 'Hi Ana,');
    await post('/requests/REQ-001/save', { body });
    expect(service.store.get('REQ-001')?.editedBody).toContain('Hi Ana,');
  });

  it('rejects with a reason and closes a request without a reply', async () => {
    await post('/requests/REQ-002/reject', { reason: 'Customer cancelled' });
    expect(service.store.get('REQ-002')?.status).toBe('rejected');
    await post('/requests/REQ-010/close', { note: 'Payment confirmation, no reply needed' });
    expect(service.store.get('REQ-010')?.status).toBe('closed');
  });

  it('blocks forms posted from another website (CSRF)', async () => {
    const res = await post('/requests/REQ-003/reject', { reason: 'x' }, { Origin: 'http://evil.example' });
    expect(res.status).toBe(403);
    expect(service.store.get('REQ-003')?.status).toBe('pending');
  });
});

describe('API for n8n', () => {
  it('accepts a new email and reports where it went', async () => {
    const res = await postJson({ messageId: '<api-1@mail.test>', from: 'someone@example.test', subject: 'Quote', body: 'GRU to MIA, 1 box' });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data).toMatchObject({ created: true, status: 'error', url: `/requests/${data.id}` });
    expect(data.error).toMatch(/Demo mode has no recorded AI answer/);
  });

  it('is safe to call twice with the same email (n8n retries)', async () => {
    const res = await postJson({ messageId: '<api-1@mail.test>', from: 'someone@example.test', subject: 'Quote', body: 'x' });
    expect(res.status).toBe(200);
    expect((await res.json()).created).toBe(false);
  });

  it('rejects bad input clearly', async () => {
    expect((await postJson({ from: 'x' })).status).toBe(400);
    const notJson = await fetch(`${base}/api/requests`, { method: 'POST', body: '{oops', headers: { 'Content-Type': 'application/json' } });
    expect(notJson.status).toBe(400);
    const form = await fetch(`${base}/api/requests`, { method: 'POST', body: 'a=b', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    expect(form.status).toBe(415);
  });

  it('escapes HTML that arrives inside an email', async () => {
    const res = await postJson({ from: 'x@example.test', subject: '<script>alert(1)</script>', body: '<img src=x onerror=alert(1)>' });
    const { id } = await res.json();
    const page = await (await fetch(`${base}/requests/${id}`)).text();
    expect(page).not.toContain('<script>alert(1)</script>');
    expect(page).not.toContain('<img src=x');
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
