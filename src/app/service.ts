// The approval flow. Every way a request can move is here, with its rules:
// - a new email is processed once (the same Message-ID twice is not re-processed);
// - only a pending request can be approved, rejected or closed;
// - a request flagged for review can only be approved after the approver
//   confirms they checked the reasons;
// - approving writes the reply to the outbox folder. Nothing is ever sent.
// Every step is written to the event log.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import company from '../../data/company.json' with { type: 'json' };
import type { IncomingEmail } from '../domain/email.ts';
import { processEmail, type AiCallers, type ProcessedRequest } from '../pipeline/process.ts';
import type { Store, StoredRequest } from '../store/db.ts';

/** A rule was broken (e.g. approving twice). The message is shown to the approver. */
export class ActionError extends Error {}

export interface ServiceOptions {
  outboxDir: string;
  /** Clock, replaceable in tests. */
  now?: () => Date;
}

export interface IngestResult {
  request: StoredRequest;
  /** False when this Message-ID was already received: nothing was processed again. */
  created: boolean;
}

/** Removes line breaks so an email header cannot be split (header injection). */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

export class QuoteService {
  readonly store: Store;
  private readonly callers: AiCallers;
  private readonly outboxDir: string;
  private readonly now: () => Date;

  constructor(store: Store, callers: AiCallers, options: ServiceOptions) {
    this.store = store;
    this.callers = callers;
    this.outboxDir = options.outboxDir;
    this.now = options.now ?? (() => new Date());
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  private require(id: string): StoredRequest {
    const r = this.store.get(id);
    if (!r) throw new ActionError(`Request ${id} not found`);
    return r;
  }

  private requirePending(id: string): StoredRequest {
    const r = this.require(id);
    if (r.status !== 'pending') throw new ActionError(`${id} is already ${r.status}`);
    return r;
  }

  /** Turns a pipeline result into a stored request and logs what happened. */
  private record(p: ProcessedRequest, createdAt: string): StoredRequest {
    const a = p.assessment;
    const request: StoredRequest = {
      id: p.id,
      email: p.email,
      status: p.status === 'error' ? 'error' : 'pending',
      outcome: a?.outcome ?? null,
      needsReview: a?.needsReview ?? false,
      priority: a?.priority ?? 'normal',
      fingerprint: a?.fingerprint ?? null,
      extraction: p.extraction,
      assessment: a,
      draft: p.draft,
      editedBody: null,
      error: p.error,
      aiRead: p.ai,
      aiWrite: p.draft?.ai ?? null,
      createdAt,
      decidedAt: null,
      decisionNote: null,
      outboxFile: null,
    };
    this.store.save(request);

    const tries = (n: number) => (n === 1 ? '1 attempt' : `${n} attempts`);
    if (p.status === 'error') {
      this.store.addEvent(p.id, 'extraction_failed', p.error, this.stamp());
      return request;
    }
    this.store.addEvent(p.id, 'extracted', `${p.ai.model}, ${tries(p.ai.attempts.length)}`, this.stamp());
    const reasons = a!.flags.filter((f) => f.severity === 'review').map((f) => f.message);
    this.store.addEvent(
      p.id,
      'assessed',
      `${a!.outcome}${reasons.length ? `; review: ${reasons.join(' | ')}` : ''}`,
      this.stamp(),
    );
    if (p.draft) {
      this.store.addEvent(
        p.id,
        'drafted',
        p.draft.textSource === 'ai' ? `text by AI, ${tries(p.draft.ai?.attempts.length ?? 1)}` : p.draft.warnings.join(' '),
        this.stamp(),
      );
    }
    return request;
  }

  /** Receives one email: from the demo inbox, the paste form or the API (n8n). */
  async ingest(email: IncomingEmail): Promise<IngestResult> {
    const existing = this.store.findByMessageId(email.messageId);
    if (existing) {
      this.store.addEvent(existing.id, 'duplicate_delivery', `Same email received again (${email.messageId})`, this.stamp());
      return { request: existing, created: false };
    }
    const id = this.store.nextId();
    const createdAt = this.stamp();
    const history = this.store.history();
    // Save first, so the email is never lost even if processing crashes.
    this.store.save({
      id, email, status: 'error', outcome: null, needsReview: false, priority: 'normal', fingerprint: null,
      extraction: null, assessment: null, draft: null, editedBody: null, error: 'Processing did not finish',
      aiRead: null, aiWrite: null, createdAt, decidedAt: null, decisionNote: null, outboxFile: null,
    });
    this.store.addEvent(id, 'received', `${email.from}: ${email.subject}`, createdAt);
    const processed = await processEmail(id, email, this.callers, history);
    return { request: this.record(processed, createdAt), created: true };
  }

  /** Runs an error-queue request through the pipeline again. */
  async retry(id: string): Promise<StoredRequest> {
    const r = this.require(id);
    if (r.status !== 'error') throw new ActionError(`Only requests in the error queue can be retried; ${id} is ${r.status}`);
    this.store.addEvent(id, 'retried', null, this.stamp());
    const history = this.store.history().filter((h) => h.id !== id);
    const processed = await processEmail(id, r.email, this.callers, history);
    return this.record(processed, r.createdAt);
  }

  saveEdit(id: string, body: string): StoredRequest {
    const r = this.requirePending(id);
    if (!r.draft) throw new ActionError(`${id} has no draft to edit`);
    if (!body.trim()) throw new ActionError('The reply cannot be empty');
    const updated = { ...r, editedBody: body === r.draft.body ? null : body };
    this.store.save(updated);
    this.store.addEvent(id, 'edited', `${body.length} characters`, this.stamp());
    return updated;
  }

  /** Approves the reply and writes it to the outbox. Nothing is sent. */
  approve(id: string, options: { body?: string; reviewConfirmed?: boolean } = {}): StoredRequest {
    const r = this.requirePending(id);
    if (!r.draft) throw new ActionError(`${id} has no draft to approve; close it instead`);
    if (r.needsReview && !options.reviewConfirmed) {
      throw new ActionError('This request is flagged for review: confirm you checked the reasons before approving');
    }
    const body = options.body ?? r.editedBody ?? r.draft.body;
    if (!body.trim()) throw new ActionError('The reply cannot be empty');
    const edited = body !== r.draft.body;
    if (edited && body !== r.editedBody) this.store.addEvent(id, 'edited', `${body.length} characters`, this.stamp());

    const at = this.now();
    mkdirSync(this.outboxDir, { recursive: true });
    const file = join(this.outboxDir, `${id}.eml`);
    const message = [
      `From: ${company.desk} <${company.email}>`,
      `To: ${oneLine(r.draft.to)}`,
      `Subject: ${oneLine(r.draft.subject)}`,
      `Date: ${at.toUTCString()}`,
      `In-Reply-To: ${oneLine(r.email.messageId)}`,
      `X-Quote-Request: ${id}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      body.replace(/\r\n/g, '\n'),
      '',
    ].join('\n');
    writeFileSync(file, message);

    const updated: StoredRequest = {
      ...r,
      status: 'approved',
      editedBody: edited ? body : null,
      decidedAt: at.toISOString(),
      decisionNote: edited ? 'approved with edits' : 'approved as drafted',
      outboxFile: file,
    };
    this.store.save(updated);
    this.store.addEvent(id, 'approved', `${updated.decisionNote}; saved to ${file}`, at.toISOString());
    return updated;
  }

  reject(id: string, reason: string): StoredRequest {
    const r = this.requirePending(id);
    if (!reason.trim()) throw new ActionError('Say why the reply is rejected');
    const updated: StoredRequest = { ...r, status: 'rejected', decidedAt: this.stamp(), decisionNote: reason.trim() };
    this.store.save(updated);
    this.store.addEvent(id, 'rejected', reason.trim(), updated.decidedAt!);
    return updated;
  }

  /** Closes a request that needs no reply (duplicate, not a quote request) or an error. */
  close(id: string, note: string): StoredRequest {
    const r = this.require(id);
    if (r.status !== 'pending' && r.status !== 'error') throw new ActionError(`${id} is already ${r.status}`);
    const updated: StoredRequest = {
      ...r,
      status: 'closed',
      decidedAt: this.stamp(),
      decisionNote: note.trim() || 'closed without reply',
    };
    this.store.save(updated);
    this.store.addEvent(id, 'closed', updated.decisionNote, updated.decidedAt!);
    return updated;
  }
}
