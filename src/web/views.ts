// The pages of the approval tool: the queue and one request.

import { requestAiTotalsStored } from './totals.ts';
import { formatQuote } from '../pricing/format.ts';
import type { RequestEvent, StoredRequest } from '../store/db.ts';
import { html, Html } from './html.ts';

export interface PageContext {
  mode: 'demo' | 'live';
  message?: string;
  error?: string;
}

const STYLE = `
:root { --ink:#1d2433; --muted:#5f6b7a; --line:#d9dee5; --bg:#f6f7f9; --card:#fff; --accent:#1f5fbf;
  --review:#b42318; --review-bg:#fdecea; --info-bg:#eef2f7; --ok:#0f7b3d; --ok-bg:#e7f6ec; --warn-bg:#fff4e0; }
* { box-sizing: border-box; }
body { margin:0; font:15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color:var(--ink); background:var(--bg); }
header.top { display:flex; align-items:center; gap:16px; padding:12px 24px; background:var(--ink); color:#fff; }
header.top a { color:#fff; text-decoration:none; font-weight:600; }
header.top nav { display:flex; gap:16px; flex:1; }
.mode { font-size:12px; padding:2px 8px; border-radius:10px; background:#ffffff26; }
main { max-width:1280px; margin:0 auto; padding:24px; }
h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:16px; margin:0 0 12px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:16px; margin-bottom:16px; }
.grid { display:grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap:16px; }
@media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
table { width:100%; border-collapse:collapse; }
th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
th { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
tr.row:hover { background:#f0f4fa; }
td a { color:var(--accent); font-weight:600; text-decoration:none; }
pre { white-space:pre-wrap; font:13px/1.45 ui-monospace, "Cascadia Mono", Menlo, monospace; margin:0; }
.badge { display:inline-block; font-size:12px; font-weight:600; padding:1px 8px; border-radius:10px; background:var(--info-bg); white-space:nowrap; }
.badge.review { background:var(--review-bg); color:var(--review); }
.badge.urgent { background:var(--review); color:#fff; }
.badge.ok { background:var(--ok-bg); color:var(--ok); }
.badge.error { background:var(--review); color:#fff; }
.flags { list-style:none; padding:0; margin:0; }
.flags li { padding:6px 10px; border-radius:6px; margin-bottom:6px; background:var(--info-bg); }
.flags li.review { background:var(--review-bg); color:var(--review); font-weight:600; }
.low { color:var(--review); font-weight:600; }
.muted { color:var(--muted); font-size:13px; }
textarea { width:100%; min-height:420px; font:13px/1.45 ui-monospace, Menlo, monospace; padding:10px; border:1px solid var(--line); border-radius:6px; }
input[type=text] { width:100%; padding:8px; border:1px solid var(--line); border-radius:6px; font:inherit; }
button { font:inherit; font-weight:600; padding:8px 14px; border-radius:6px; border:1px solid var(--line); background:#fff; cursor:pointer; }
button.primary { background:var(--ok); border-color:var(--ok); color:#fff; }
button.danger { color:var(--review); border-color:var(--review); }
.actions { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:12px; }
.confirm { display:block; background:var(--review-bg); color:var(--review); padding:10px; border-radius:6px; margin-top:12px; }
.flash { padding:10px 14px; border-radius:6px; margin-bottom:16px; background:var(--ok-bg); color:var(--ok); font-weight:600; }
.flash.error { background:var(--review-bg); color:var(--review); }
.warn { background:var(--warn-bg); padding:8px 10px; border-radius:6px; }
ol.events { margin:0; padding-left:20px; } ol.events li { margin-bottom:4px; }
`;

export function layout(title: string, ctx: PageContext, body: Html): string {
  return html`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Air Cargo Quote Assistant</title><style>${new Html(STYLE)}</style></head>
<body>
<header class="top"><nav><a href="/">Approval queue</a><a href="/dashboard">Dashboard</a>${ctx.mode === 'live' ? html`<a href="/new">Paste an email</a>` : ''}</nav>
<span class="mode">${ctx.mode === 'demo' ? 'DEMO MODE · recorded AI answers' : 'LIVE MODE · real AI'}</span></header>
<main>
${ctx.message ? html`<div class="flash">${ctx.message}</div>` : ''}
${ctx.error ? html`<div class="flash error">${ctx.error}</div>` : ''}
${body}
</main></body></html>`.value;
}

const money = (cents: number) => (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
const when = (iso: string) => iso.replace('T', ' ').slice(0, 16);
const outcomeLabel = (r: StoredRequest) => (r.status === 'error' ? 'error' : (r.outcome ?? '').replaceAll('_', ' '));

function statusBadge(r: StoredRequest): Html {
  const cls = r.status === 'approved' ? 'ok' : r.status === 'error' ? 'error' : '';
  return html`<span class="badge ${cls}">${r.status}</span>`;
}

function markers(r: StoredRequest): Html {
  return html`${r.priority === 'urgent' ? html`<span class="badge urgent">URGENT</span> ` : ''}${
    r.needsReview && r.status === 'pending' ? html`<span class="badge review">needs review</span>` : ''
  }`;
}

function queueTable(rows: StoredRequest[], empty: string): Html {
  if (rows.length === 0) return html`<p class="muted">${empty}</p>`;
  return html`<table><thead><tr><th>Request</th><th>Received</th><th>From</th><th>Subject</th><th>Outcome</th><th>Total</th><th></th></tr></thead><tbody>
${rows.map(
  (r) => html`<tr class="row"><td><a href="/requests/${r.id}">${r.id}</a></td><td>${when(r.email.receivedAt)}</td><td>${r.email.from}</td>
<td>${r.email.subject}</td><td>${outcomeLabel(r)}</td>
<td>${r.assessment?.quote ? `USD ${money(r.assessment.quote.totalCents)}` : ''}</td><td>${markers(r)} ${r.status === 'pending' ? '' : statusBadge(r)}</td></tr>`,
)}</tbody></table>`;
}

export function queuePage(requests: StoredRequest[], ctx: PageContext): string {
  const pending = requests
    .filter((r) => r.status === 'pending')
    .sort(
      (a, b) =>
        Number(b.priority === 'urgent') - Number(a.priority === 'urgent') ||
        Number(b.needsReview) - Number(a.needsReview) ||
        a.id.localeCompare(b.id),
    );
  const errors = requests.filter((r) => r.status === 'error');
  const done = requests.filter((r) => ['approved', 'rejected', 'closed'].includes(r.status));
  return layout(
    'Approval queue',
    ctx,
    html`<h1>Approval queue</h1>
<p class="muted">No reply leaves without a person approving it. Approved replies are saved to the outbox folder; nothing is sent.</p>
<div class="card"><h2>Waiting for approval (${pending.length})</h2>${queueTable(pending, 'Nothing waiting.')}</div>
<div class="card"><h2>Error queue (${errors.length})</h2>${queueTable(errors, 'No errors.')}</div>
<div class="card"><h2>Done (${done.length})</h2>${queueTable(done, 'Nothing decided yet.')}</div>
${ctx.mode === 'demo'
  ? html`<form method="post" action="/demo/reset" class="actions"><button>Reset demo</button>
<span class="muted">Deletes all decisions and loads the 10 demo emails again.</span></form>`
  : ''}`,
  );
}

function extractionTable(r: StoredRequest): Html {
  const x = r.extraction;
  if (!x) return html`<p class="muted">Nothing extracted.</p>`;
  const c = x.confidence;
  const conf = (v: number, filled: boolean) =>
    filled ? html`<span class="${v < 0.8 ? 'low' : 'muted'}">${Math.round(v * 100)}%</span>` : html`<span class="muted">n/a</span>`;
  const pieces = x.pieces?.map((p) => `${p.count} x ${p.length} x ${p.width} x ${p.height} ${p.unit}`).join('\n') ?? '';
  const a = r.assessment;
  const rows: [string, string, Html][] = [
    ['Quote request?', x.isQuoteRequest ? 'yes' : 'no', html``],
    ['Origin', `${x.origin ?? '-'}${a?.origin && a.origin.iata !== x.origin ? `  ->  ${a.origin.iata}` : ''}`, conf(c.origin, !!x.origin)],
    ['Destination', `${x.destination ?? '-'}${a?.destination && a.destination.iata !== x.destination ? `  ->  ${a.destination.iata}` : ''}`, conf(c.destination, !!x.destination)],
    ['Pieces', pieces || '-', conf(c.pieces, !!x.pieces)],
    ['Weight', x.weight ? `${x.weight.value} ${x.weight.unit} (${x.weight.per})` : '-', conf(c.weight, !!x.weight)],
    ['Cargo type', `${x.cargoType ?? '-'}${x.cargoDescription ? ` · ${x.cargoDescription}` : ''}`, conf(c.cargoType, !!x.cargoType)],
    ['Ready date', x.readyDate ?? '-', conf(c.readyDate, !!x.readyDate)],
    ['Urgent', x.urgent ? 'yes' : 'no', html``],
    ['Sender', [x.sender.name, x.sender.company].filter(Boolean).join(', ') || '-', html``],
  ];
  return html`<table><thead><tr><th>Field</th><th>Value</th><th>AI confidence</th></tr></thead><tbody>
${rows.map(([k, v, cf]) => html`<tr><td>${k}</td><td><pre>${v}</pre></td><td>${cf}</td></tr>`)}</tbody></table>`;
}

function draftSection(r: StoredRequest): Html {
  const d = r.draft;
  if (r.status === 'error') {
    return html`<div class="card"><h2>Error queue</h2><p class="flash error">${r.error}</p>
<div class="actions"><form method="post" action="/requests/${r.id}/retry"><button class="primary">Retry</button></form>
<form method="post" action="/requests/${r.id}/close" class="actions"><input type="text" name="note" placeholder="Note (optional)" style="width:260px"><button>Close without reply</button></form></div></div>`;
  }
  if (!d) {
    return html`<div class="card"><h2>No reply drafted</h2>
<p class="muted">${r.outcome === 'duplicate' ? `Duplicate of ${r.assessment?.duplicateOf}. Answer the original request instead.` : 'This email does not need a quote. A person decides what to do.'}</p>
${r.status === 'pending'
  ? html`<form method="post" action="/requests/${r.id}/close" class="actions"><input type="text" name="note" placeholder="Note (optional)" style="width:320px"><button>Close without reply</button></form>`
  : ''}</div>`;
  }
  const body = r.editedBody ?? d.body;
  if (r.status !== 'pending') {
    return html`<div class="card"><h2>Reply (${r.status})</h2>
<p class="muted">To: ${d.to} · Subject: ${d.subject}${r.outboxFile ? ` · Saved to ${r.outboxFile}` : ''}</p>
<pre>${body}</pre></div>`;
  }
  const reasons = r.assessment?.flags.filter((f) => f.severity === 'review') ?? [];
  return html`<div class="card"><h2>Reply draft</h2>
<p class="muted">To: ${d.to} · Subject: ${d.subject} · Greeting, opening and closing by ${d.textSource === 'ai' ? 'AI' : 'the standard template'}; everything with numbers by code.${r.editedBody ? ' · Edited.' : ''}</p>
${d.warnings.map((w) => html`<p class="warn">${w}</p>`)}
<form method="post" action="/requests/${r.id}/approve">
<textarea name="body" aria-label="Reply text">${body}</textarea>
${reasons.length
  ? html`<label class="confirm"><input type="checkbox" name="reviewConfirmed" value="yes" required> I checked: ${reasons.map((f) => f.message).join(' · ')}</label>`
  : ''}
<div class="actions"><button class="primary">Approve (save to outbox)</button>
<button formaction="/requests/${r.id}/save" formnovalidate>Save edits</button></div></form>
<form method="post" action="/requests/${r.id}/reject" class="actions"><input type="text" name="reason" placeholder="Why reject? (required)" style="width:320px" required>
<button class="danger">Reject</button></form></div>`;
}

export function requestPage(r: StoredRequest, events: RequestEvent[], ctx: PageContext): string {
  const a = r.assessment;
  const reviewFlags = a?.flags.filter((f) => f.severity === 'review') ?? [];
  const infoFlags = a?.flags.filter((f) => f.severity === 'info') ?? [];
  const ai = requestAiTotalsStored(r);
  return layout(
    r.id,
    ctx,
    html`<h1>${r.id} · ${r.email.subject}</h1>
<p>${statusBadge(r)} <span class="badge">${outcomeLabel(r)}</span> ${markers(r)}
${a?.quote ? html` <strong>USD ${money(a.quote.totalCents)}</strong>` : ''}</p>
${reviewFlags.length || infoFlags.length
  ? html`<div class="card"><h2>${reviewFlags.length ? 'Why this needs review' : 'Notes'}</h2><ul class="flags">
${reviewFlags.map((f) => html`<li class="review">${f.message}</li>`)}${infoFlags.map((f) => html`<li>${f.message}</li>`)}</ul></div>`
  : ''}
<div class="grid">
<div class="card"><h2>Original email</h2><p class="muted">From ${r.email.from} · ${when(r.email.receivedAt)} UTC</p><pre>${r.email.body}</pre></div>
<div class="card"><h2>What the AI extracted</h2>${extractionTable(r)}</div>
</div>
${a?.quote ? html`<div class="card"><h2>Price calculation (by code)</h2><pre>${formatQuote(a.quote)}</pre></div>` : ''}
${draftSection(r)}
<div class="grid">
<div class="card"><h2>History</h2><ol class="events">${events.map(
      (e) => html`<li><span class="muted">${when(e.at)}</span> <strong>${e.type.replaceAll('_', ' ')}</strong>${e.detail ? ` · ${e.detail}` : ''}</li>`,
    )}</ol></div>
<div class="card"><h2>AI usage</h2><p>Reading: ${r.aiRead ? `${r.aiRead.inputTokens} in + ${r.aiRead.outputTokens} out tokens, ${r.aiRead.attempts.length} attempt(s)` : 'n/a'}<br>
Writing: ${r.aiWrite ? `${r.aiWrite.inputTokens} in + ${r.aiWrite.outputTokens} out tokens, ${r.aiWrite.attempts.length} attempt(s)` : 'n/a'}<br>
<strong>Cost: US$ ${ai.costUsd.toFixed(5)}</strong> <span class="muted">(${r.aiRead?.model ?? ''})</span></p></div>
</div>`,
  );
}

export function pastePage(ctx: PageContext): string {
  return layout(
    'Paste an email',
    ctx,
    html`<h1>Paste an email</h1><p class="muted">The real AI reads it, just like an email arriving through n8n.</p>
<form method="post" action="/new" class="card">
<p><label>From<br><input type="text" name="from" required placeholder="someone@example.test"></label></p>
<p><label>Subject<br><input type="text" name="subject" required></label></p>
<p><label>Body<br><textarea name="body" required style="min-height:220px"></textarea></label></p>
<div class="actions"><button class="primary">Process</button></div></form>`,
  );
}

export function notFoundPage(ctx: PageContext): string {
  return layout('Not found', ctx, html`<h1>Not found</h1><p><a href="/">Back to the queue</a></p>`);
}
