// An incoming email, as the pipeline receives it (from the demo folder or an IMAP trigger).

export interface IncomingEmail {
  /** The Message-ID header. The same email delivered twice has the same id. */
  messageId: string;
  /** Sender address, e.g. "ops@example-forwarder.test". */
  from: string;
  subject: string;
  /** ISO 8601 timestamp, e.g. "2026-11-09T14:05:00Z". */
  receivedAt: string;
  body: string;
}
