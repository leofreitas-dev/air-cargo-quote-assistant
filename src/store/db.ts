// Where every request is kept: SQLite, built into Node 24 (node:sqlite),
// so there is nothing to install. One row per request, plus an event log
// with every step (received, extracted, drafted, edited, approved...).

import { DatabaseSync } from 'node:sqlite';
import type { AiUsage } from '../ai/call.ts';
import type { IncomingEmail } from '../domain/email.ts';
import type { Extraction } from '../domain/extraction.ts';
import type { Draft } from '../drafting/draft.ts';
import type { Assessment } from '../validation/assess.ts';
import type { PreviousRequest } from '../validation/duplicates.ts';

/** Where a request is in the approval flow. */
export type RequestStatus =
  | 'pending' // waiting for a person
  | 'approved' // reply approved and saved to the outbox
  | 'rejected' // reply rejected, nothing sent
  | 'closed' // no reply needed (duplicate, not a quote request)
  | 'error'; // in the error queue (the AI could not read it)

export interface StoredRequest {
  id: string;
  email: IncomingEmail;
  status: RequestStatus;
  outcome: Assessment['outcome'] | null;
  needsReview: boolean;
  priority: 'urgent' | 'normal';
  fingerprint: string | null;
  extraction: Extraction | null;
  assessment: Assessment | null;
  draft: Draft | null;
  /** The reply as the approver edited it, if they did. */
  editedBody: string | null;
  error: string | null;
  aiRead: AiUsage | null;
  aiWrite: AiUsage | null;
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
  outboxFile: string | null;
}

export interface RequestEvent {
  requestId: string;
  at: string;
  type: string;
  detail: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE,
  received_at TEXT NOT NULL,
  email_json TEXT NOT NULL,
  status TEXT NOT NULL,
  outcome TEXT,
  needs_review INTEGER NOT NULL DEFAULT 0,
  priority TEXT NOT NULL DEFAULT 'normal',
  fingerprint TEXT,
  extraction_json TEXT,
  assessment_json TEXT,
  draft_json TEXT,
  edited_body TEXT,
  error TEXT,
  ai_read_json TEXT,
  ai_write_json TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decision_note TEXT,
  outbox_file TEXT
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL REFERENCES requests(id),
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS events_by_request ON events(request_id, seq);
`;

type Row = Record<string, string | number | null>;
const json = <T>(v: string | number | null): T | null => (typeof v === 'string' ? (JSON.parse(v) as T) : null);
const str = (v: string | number | null): string | null => (v === null ? null : String(v));

function fromRow(r: Row): StoredRequest {
  return {
    id: String(r.id),
    email: json<IncomingEmail>(r.email_json)!,
    status: r.status as RequestStatus,
    outcome: str(r.outcome) as StoredRequest['outcome'],
    needsReview: r.needs_review === 1,
    priority: r.priority as StoredRequest['priority'],
    fingerprint: str(r.fingerprint),
    extraction: json(r.extraction_json),
    assessment: json(r.assessment_json),
    draft: json(r.draft_json),
    editedBody: str(r.edited_body),
    error: str(r.error),
    aiRead: json(r.ai_read_json),
    aiWrite: json(r.ai_write_json),
    createdAt: String(r.created_at),
    decidedAt: str(r.decided_at),
    decisionNote: str(r.decision_note),
    outboxFile: str(r.outbox_file),
  };
}

export class Store {
  private readonly db: DatabaseSync;

  /** @param file a path, or ":memory:" for tests */
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  nextId(): string {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number };
    return `REQ-${String(row.n + 1).padStart(3, '0')}`;
  }

  findByMessageId(messageId: string): StoredRequest | null {
    const row = this.db.prepare('SELECT * FROM requests WHERE message_id = ?').get(messageId) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  get(id: string): StoredRequest | null {
    const row = this.db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  list(): StoredRequest[] {
    return (this.db.prepare('SELECT * FROM requests ORDER BY id').all() as Row[]).map(fromRow);
  }

  /** Earlier requests, for duplicate detection. */
  history(): PreviousRequest[] {
    const rows = this.db
      .prepare('SELECT id, message_id, fingerprint, received_at FROM requests WHERE fingerprint IS NOT NULL')
      .all() as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      messageId: String(r.message_id),
      fingerprint: String(r.fingerprint),
      receivedAt: String(r.received_at),
    }));
  }

  /** Saves a new request or replaces an existing one (after a retry). */
  save(r: StoredRequest): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO requests (id, message_id, received_at, email_json, status, outcome, needs_review,
           priority, fingerprint, extraction_json, assessment_json, draft_json, edited_body, error, ai_read_json,
           ai_write_json, created_at, decided_at, decision_note, outbox_file)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.id,
        r.email.messageId,
        r.email.receivedAt,
        JSON.stringify(r.email),
        r.status,
        r.outcome,
        r.needsReview ? 1 : 0,
        r.priority,
        r.fingerprint,
        r.extraction ? JSON.stringify(r.extraction) : null,
        r.assessment ? JSON.stringify(r.assessment) : null,
        r.draft ? JSON.stringify(r.draft) : null,
        r.editedBody,
        r.error,
        r.aiRead ? JSON.stringify(r.aiRead) : null,
        r.aiWrite ? JSON.stringify(r.aiWrite) : null,
        r.createdAt,
        r.decidedAt,
        r.decisionNote,
        r.outboxFile,
      );
  }

  addEvent(requestId: string, type: string, detail: string | null = null, at = new Date().toISOString()): void {
    this.db.prepare('INSERT INTO events (request_id, at, type, detail) VALUES (?, ?, ?, ?)').run(requestId, at, type, detail);
  }

  events(requestId?: string): RequestEvent[] {
    const rows = (
      requestId
        ? this.db.prepare('SELECT * FROM events WHERE request_id = ? ORDER BY seq').all(requestId)
        : this.db.prepare('SELECT * FROM events ORDER BY seq').all()
    ) as Row[];
    return rows.map((r) => ({ requestId: String(r.request_id), at: String(r.at), type: String(r.type), detail: str(r.detail) }));
  }

  /** Deletes everything (demo reset). */
  clear(): void {
    this.db.exec('DELETE FROM events; DELETE FROM requests;');
  }
}
