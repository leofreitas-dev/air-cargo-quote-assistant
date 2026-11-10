// The dashboard page: volume, time to decision, problems by type, AI cost.
// Headline numbers are stat tiles (one value each); "problems by type" is a
// single-series horizontal bar chart (comparing magnitudes), labeled with
// its numbers so it never depends on color; cost per request is a table.

import type { Metrics } from '../app/metrics.ts';
import { html, Html } from './html.ts';
import { layout, type PageContext } from './views.ts';

/** Bar color: blue from the dataviz reference palette, validated against the light surface. */
const BAR = '#2a78d6';

const STYLE = new Html(`
.tiles { display:grid; grid-template-columns:repeat(auto-fit, minmax(190px, 1fr)); gap:12px; margin-bottom:16px; }
.tile { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:14px 16px; }
.tile .label { font-size:13px; color:var(--muted); }
.tile .value { font-size:28px; font-weight:700; line-height:1.2; margin:4px 0; font-variant-numeric:tabular-nums; }
.tile .sub { font-size:13px; color:var(--muted); }
.bars td { border-bottom:none; padding:4px 8px; }
.bars td.name { width:45%; }
.bars .track { display:flex; align-items:center; gap:8px; }
.bars .bar { height:14px; background:${BAR}; border-radius:0 4px 4px 0; min-width:4px; }
.bars .bar:hover { filter:brightness(0.9); }
.bars .num { font-variant-numeric:tabular-nums; font-weight:600; }
td.n, th.n { text-align:right; font-variant-numeric:tabular-nums; }
`);

export function formatMinutes(min: number | null): string {
  if (min === null) return '-';
  if (min < 1) return 'under 1 min';
  if (min < 60) return `${Math.round(min)} min`;
  if (min < 24 * 60) return `${Math.floor(min / 60)} h ${Math.round(min % 60)} min`;
  return `${(min / (24 * 60)).toFixed(1)} days`;
}

const usd = (n: number, decimals = 4) => `US$ ${n.toFixed(decimals)}`;
const pct = (n: number | null) => (n === null ? '-' : `${Math.round(n * 100)}%`);
const int = (n: number) => n.toLocaleString('en-US');
const label = (s: string) => s.replaceAll('_', ' ');

function tile(name: string, value: string, sub: string): Html {
  return html`<div class="tile"><div class="label">${name}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
}

function problemsChart(m: Metrics): Html {
  if (m.problems.length === 0) return html`<p class="muted">No problems recorded.</p>`;
  const max = Math.max(...m.problems.map((p) => p.count));
  return html`<table class="bars" aria-label="Problems by type"><thead><tr><th>Problem</th><th>Requests or attempts</th></tr></thead><tbody>
${m.problems.map(
  (p) => html`<tr><td class="name">${p.label}</td><td><div class="track">
<div class="bar" style="width:${Math.max(2, (p.count / max) * 85).toFixed(1)}%" title="${p.label}: ${p.count}"></div>
<span class="num">${p.count}</span></div></td></tr>`,
)}</tbody></table>`;
}

export function dashboardPage(m: Metrics, ctx: PageContext): string {
  const v = m.volume;
  const d = m.decisions;
  const ai = m.ai;
  const per1000 = ai.costPerRequest === null ? '-' : usd(ai.costPerRequest * 1000, 2);
  const counts = (rec: Record<string, number>) =>
    Object.entries(rec)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => html`<tr><td>${label(k)}</td><td class="n">${n}</td></tr>`);

  return layout(
    'Dashboard',
    ctx,
    html`<style>${STYLE}</style>
<h1>Dashboard</h1>
<p class="muted">Computed from the requests and their history in the database. Times run from arrival in this tool to the decision.</p>
<div class="tiles">
${tile('Requests', int(v.total), `${v.byStatus.pending} waiting · ${v.byStatus.error} in the error queue`)}
${tile('Needed review', int(v.needsReview), `${v.urgent} urgent`)}
${tile('Median time to decision', formatMinutes(d.medianMinutes), `average ${formatMinutes(d.averageMinutes)} · ${d.decided} decided`)}
${tile('Oldest waiting', formatMinutes(d.oldestPendingMinutes), `${v.byStatus.pending} still pending`)}
${tile('Replies edited before approval', pct(d.editRate), `${d.approvedWithEdits} of ${d.approved} approved replies`)}
${tile('AI cost', usd(ai.costUsd), `about ${per1000} per 1,000 emails`)}
</div>
<div class="grid">
<div class="card"><h2>Problems by type</h2>${problemsChart(m)}
<p class="muted">Review reasons count requests; "AI answer rejected and retried" counts attempts.</p></div>
<div class="card"><h2>Volume</h2>
<table><thead><tr><th>Outcome</th><th class="n">Requests</th></tr></thead><tbody>${counts(v.byOutcome)}</tbody></table>
<h2 style="margin-top:16px">Decisions</h2>
<table><tbody>
<tr><td>Approved as drafted</td><td class="n">${d.approvedAsDrafted}</td></tr>
<tr><td>Approved with edits</td><td class="n">${d.approvedWithEdits}</td></tr>
<tr><td>Rejected</td><td class="n">${d.rejected}</td></tr>
<tr><td>Closed without reply</td><td class="n">${d.closed}</td></tr>
<tr><td>Still waiting</td><td class="n">${v.byStatus.pending}</td></tr>
</tbody></table></div>
</div>
<div class="card"><h2>AI usage and cost</h2>
<p>${int(ai.inputTokens)} input + ${int(ai.outputTokens)} output tokens ·
reading ${usd(ai.readCostUsd)} · writing ${usd(ai.writeCostUsd)} ·
${ai.rejectedAttempts} rejected attempt(s) cost ${usd(ai.rejectedAttemptsCostUsd, 5)}</p>
<table><thead><tr><th>Request</th><th>Outcome</th><th class="n">Reading tokens</th><th class="n">Writing tokens</th><th class="n">Cost</th></tr></thead><tbody>
${ai.perRequest.map(
  (r) => html`<tr><td><a href="/requests/${r.id}">${r.id}</a></td><td>${label(r.outcome)}</td><td class="n">${int(r.readTokens)}</td>
<td class="n">${r.writeTokens ? int(r.writeTokens) : '-'}</td><td class="n">${usd(r.costUsd, 5)}</td></tr>`,
)}
<tr><td><strong>Total</strong></td><td></td><td></td><td></td><td class="n"><strong>${usd(ai.costUsd, 5)}</strong></td></tr>
</tbody></table></div>`,
  );
}
