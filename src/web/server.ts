// The local web server: the approval pages, plus a small JSON API that n8n
// (wave 8) calls to hand over new emails. Built on node:http only.
// Listens on 127.0.0.1, so it is reachable from this computer only.

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { ActionError, type QuoteService } from '../app/service.ts';
import type { IncomingEmail } from '../domain/email.ts';
import type { StoredRequest } from '../store/db.ts';
import { computeMetrics } from '../app/metrics.ts';
import { dashboardPage } from './dashboard.ts';
import { notFoundPage, pastePage, queuePage, requestPage, type PageContext } from './views.ts';

export interface ServerOptions {
  service: QuoteService;
  mode: 'demo' | 'live';
  /** Called by the "Reset demo" button (demo mode only). */
  resetDemo?: () => Promise<void>;
}

const MAX_BODY = 1_000_000; // 1 MB is plenty for one email

/** What the API accepts. Message-ID and date are optional: they are filled in if missing. */
const ApiEmailSchema = z.object({
  messageId: z.string().min(1).optional(),
  from: z.string().min(3),
  subject: z.string(),
  receivedAt: z.iso.datetime().optional(),
  body: z.string().min(1),
});

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new ActionError('Request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

const sendJson = (res: ServerResponse, status: number, data: unknown) =>
  send(res, status, JSON.stringify(data, null, 2), 'application/json; charset=utf-8');

function redirect(res: ServerResponse, to: string, flash?: { message?: string; error?: string }) {
  const q = new URLSearchParams();
  if (flash?.message) q.set('msg', flash.message);
  if (flash?.error) q.set('err', flash.error);
  res.writeHead(303, { Location: q.size ? `${to}?${q}` : to });
  res.end();
}

/** Blocks form posts coming from another website (CSRF). */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // tools like curl send no Origin
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function toApiResult(r: StoredRequest, created: boolean) {
  const reasons = r.assessment?.flags.filter((f) => f.severity === 'review').map((f) => f.message) ?? [];
  return {
    id: r.id,
    created,
    status: r.status,
    outcome: r.outcome,
    needsReview: r.needsReview,
    priority: r.priority,
    reviewReasons: reasons,
    subject: r.email.subject,
    from: r.email.from,
    // Not called "error": n8n treats any output with a filled "error" field as a
    // failed call and retries it.
    errorReason: r.error,
    url: `/requests/${r.id}`,
  };
}

export function createAppServer({ service, mode, resetDemo }: ServerOptions): Server {
  const store = service.store;

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const ctx: PageContext = { mode, message: url.searchParams.get('msg') ?? undefined, error: url.searchParams.get('err') ?? undefined };
    const requestMatch = /^\/requests\/(REQ-\d+)(?:\/(approve|save|reject|close|retry))?$/.exec(path);

    try {
      // ---- JSON API (for n8n) ----
      if (path === '/api/health' && req.method === 'GET') return sendJson(res, 200, { ok: true, mode });
      if (path === '/api/metrics' && req.method === 'GET') return sendJson(res, 200, computeMetrics(store.list(), store.events()));
      if (path === '/api/requests' && req.method === 'POST') {
        if (!req.headers['content-type']?.startsWith('application/json')) {
          return sendJson(res, 415, { error: 'Send JSON (Content-Type: application/json)' });
        }
        const parsed = ApiEmailSchema.safeParse(JSON.parse(await readBody(req)));
        if (!parsed.success) return sendJson(res, 400, { error: 'Invalid email', issues: parsed.error.issues });
        const email: IncomingEmail = {
          messageId: parsed.data.messageId ?? `<${randomUUID()}@api.local>`,
          from: parsed.data.from,
          subject: parsed.data.subject,
          receivedAt: parsed.data.receivedAt ?? new Date().toISOString(),
          body: parsed.data.body,
        };
        const { request, created } = await service.ingest(email);
        return sendJson(res, created ? 201 : 200, toApiResult(request, created));
      }
      const apiMatch = /^\/api\/requests\/(REQ-\d+)$/.exec(path);
      if (apiMatch && req.method === 'GET') {
        const r = store.get(apiMatch[1]!);
        return r ? sendJson(res, 200, r) : sendJson(res, 404, { error: 'Not found' });
      }

      // ---- Pages ----
      if (req.method === 'GET') {
        if (path === '/') return send(res, 200, queuePage(store.list(), ctx));
        if (path === '/dashboard') return send(res, 200, dashboardPage(computeMetrics(store.list(), store.events()), ctx));
        if (path === '/new' && mode === 'live') return send(res, 200, pastePage(ctx));
        if (requestMatch && !requestMatch[2]) {
          const r = store.get(requestMatch[1]!);
          if (r) return send(res, 200, requestPage(r, store.events(r.id), ctx));
        }
        return send(res, 404, notFoundPage(ctx));
      }

      // ---- Form actions ----
      if (req.method === 'POST') {
        if (!sameOrigin(req)) return send(res, 403, 'Forbidden: form posted from another site', 'text/plain');
        const form = new URLSearchParams(await readBody(req));

        if (path === '/demo/reset' && mode === 'demo' && resetDemo) {
          await resetDemo();
          return redirect(res, '/', { message: 'Demo reset: the 10 demo emails were loaded again.' });
        }
        if (path === '/new' && mode === 'live') {
          const { request } = await service.ingest({
            messageId: `<${randomUUID()}@paste.local>`,
            from: form.get('from') ?? '',
            subject: form.get('subject') ?? '',
            receivedAt: new Date().toISOString(),
            body: form.get('body') ?? '',
          });
          return redirect(res, `/requests/${request.id}`, { message: `Processed as ${request.id}.` });
        }
        if (requestMatch && requestMatch[2]) {
          const id = requestMatch[1]!;
          const back = `/requests/${id}`;
          try {
            switch (requestMatch[2]) {
              case 'approve': {
                const r = service.approve(id, { body: form.get('body') ?? undefined, reviewConfirmed: form.get('reviewConfirmed') === 'yes' });
                return redirect(res, '/', { message: `${id} approved and saved to ${r.outboxFile}. Nothing was sent.` });
              }
              case 'save':
                service.saveEdit(id, form.get('body') ?? '');
                return redirect(res, back, { message: 'Edits saved.' });
              case 'reject':
                service.reject(id, form.get('reason') ?? '');
                return redirect(res, '/', { message: `${id} rejected.` });
              case 'close':
                service.close(id, form.get('note') ?? '');
                return redirect(res, '/', { message: `${id} closed without reply.` });
              case 'retry': {
                const r = await service.retry(id);
                return redirect(res, back, r.status === 'error' ? { error: 'Still failing: the request stays in the error queue.' } : { message: 'Processed.' });
              }
            }
          } catch (error) {
            if (error instanceof ActionError) return redirect(res, back, { error: error.message });
            throw error;
          }
        }
      }
      return send(res, 404, notFoundPage(ctx));
    } catch (error) {
      if (error instanceof SyntaxError && path.startsWith('/api/')) return sendJson(res, 400, { error: 'Body is not valid JSON' });
      if (error instanceof ActionError) return send(res, 400, error.message, 'text/plain');
      console.error(error);
      return send(res, 500, 'Something went wrong. See the server log.', 'text/plain');
    }
  });
}
