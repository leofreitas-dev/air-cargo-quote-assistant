// The numbers on the dashboard, computed from the stored requests and their
// event log. Nothing here is estimated: every number can be traced back to
// rows in the database.

import { totalUsage } from '../ai/call.ts';
import type { RequestEvent, RequestStatus, StoredRequest } from '../store/db.ts';

export interface ProblemCount {
  code: string;
  label: string;
  count: number;
}

export interface RequestCostRow {
  id: string;
  outcome: string;
  readTokens: number;
  writeTokens: number;
  costUsd: number;
}

export interface Metrics {
  volume: {
    total: number;
    byStatus: Record<RequestStatus, number>;
    byOutcome: Record<string, number>;
    needsReview: number;
    urgent: number;
  };
  decisions: {
    decided: number;
    approved: number;
    approvedAsDrafted: number;
    approvedWithEdits: number;
    rejected: number;
    closed: number;
    /** Share of approved replies the approver changed (null when nothing approved). */
    editRate: number | null;
    /** Minutes from arrival in the tool to the decision. Null when nothing decided. */
    medianMinutes: number | null;
    averageMinutes: number | null;
    /** How long the oldest pending request has been waiting, in minutes. */
    oldestPendingMinutes: number | null;
  };
  problems: ProblemCount[];
  ai: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    costPerRequest: number | null;
    readCostUsd: number;
    writeCostUsd: number;
    /** Attempts the AI had to repeat, and what they cost. */
    rejectedAttempts: number;
    rejectedAttemptsCostUsd: number;
    perRequest: RequestCostRow[];
  };
}

/** Plain-language names for each kind of problem. */
const PROBLEM_LABELS: Record<string, string> = {
  missing_fields: 'Missing information',
  unknown_airport: 'Unknown airport',
  ambiguous_airport: 'Ambiguous airport',
  same_origin_and_destination: 'Same origin and destination',
  no_rate_for_route: 'No rate for the route',
  dangerous_goods: 'Dangerous goods',
  perishable: 'Perishable cargo',
  low_confidence: 'AI not sure about a field',
  duplicate_shipment: 'Same shipment asked again',
  ready_date_in_past: 'Ready date in the past',
  not_a_quote_request: 'Not a quote request',
  extraction_failed: 'AI could not read the email (error queue)',
  draft_template: 'Reply text from the template (AI failed)',
  ai_retry: 'AI answer rejected and retried',
  duplicate_delivery: 'Same email delivered twice (ignored)',
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const minutesBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 60_000;

export function computeMetrics(requests: StoredRequest[], events: RequestEvent[], now = new Date()): Metrics {
  const byStatus: Record<RequestStatus, number> = { pending: 0, approved: 0, rejected: 0, closed: 0, error: 0 };
  const byOutcome: Record<string, number> = {};
  for (const r of requests) {
    byStatus[r.status]++;
    const key = r.status === 'error' ? 'error' : (r.outcome ?? 'unknown');
    byOutcome[key] = (byOutcome[key] ?? 0) + 1;
  }

  const decided = requests.filter((r) => r.decidedAt && ['approved', 'rejected', 'closed'].includes(r.status));
  const approved = decided.filter((r) => r.status === 'approved');
  const withEdits = approved.filter((r) => r.editedBody !== null).length;
  const durations = decided.map((r) => minutesBetween(r.createdAt, r.decidedAt!));
  const pendingAges = requests.filter((r) => r.status === 'pending').map((r) => minutesBetween(r.createdAt, now.toISOString()));

  // Problems by type: review reasons, plus what went wrong in the pipeline.
  const counts = new Map<string, number>();
  const bump = (code: string, n = 1) => counts.set(code, (counts.get(code) ?? 0) + n);
  for (const r of requests) {
    for (const f of r.assessment?.flags ?? []) if (f.severity === 'review') bump(f.code);
    if (r.status === 'error') bump('extraction_failed');
    if (r.draft?.textSource === 'template') bump('draft_template');
    const rejected = [...(r.aiRead?.attempts ?? []), ...(r.aiWrite?.attempts ?? [])].filter((a) => !a.ok).length;
    if (rejected) bump('ai_retry', rejected);
  }
  bump('duplicate_delivery', events.filter((e) => e.type === 'duplicate_delivery').length);
  const problems = [...counts]
    .filter(([, n]) => n > 0)
    .map(([code, count]) => ({ code, label: PROBLEM_LABELS[code] ?? code, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  // AI usage and cost.
  const perRequest = requests.map((r): RequestCostRow => {
    const t = totalUsage(r.aiRead, r.aiWrite);
    return {
      id: r.id,
      outcome: r.status === 'error' ? 'error' : (r.outcome ?? ''),
      readTokens: (r.aiRead?.inputTokens ?? 0) + (r.aiRead?.outputTokens ?? 0),
      writeTokens: (r.aiWrite?.inputTokens ?? 0) + (r.aiWrite?.outputTokens ?? 0),
      costUsd: t.costUsd,
    };
  });
  const all = totalUsage(...requests.flatMap((r) => [r.aiRead, r.aiWrite]));
  const read = totalUsage(...requests.map((r) => r.aiRead));
  const write = totalUsage(...requests.map((r) => r.aiWrite));
  let rejectedAttempts = 0;
  let rejectedAttemptsCostUsd = 0;
  for (const r of requests) {
    for (const usage of [r.aiRead, r.aiWrite]) {
      if (!usage) continue;
      for (const a of usage.attempts) {
        if (a.ok) continue;
        rejectedAttempts++;
        // Share of this call's cost that went to the rejected attempt.
        const tokens = usage.inputTokens + usage.outputTokens;
        if (tokens > 0) rejectedAttemptsCostUsd += (usage.costUsd * (a.usage.inputTokens + a.usage.outputTokens)) / tokens;
      }
    }
  }

  return {
    volume: {
      total: requests.length,
      byStatus,
      byOutcome,
      needsReview: requests.filter((r) => r.needsReview).length,
      urgent: requests.filter((r) => r.priority === 'urgent').length,
    },
    decisions: {
      decided: decided.length,
      approved: approved.length,
      approvedAsDrafted: approved.length - withEdits,
      approvedWithEdits: withEdits,
      rejected: byStatus.rejected,
      closed: byStatus.closed,
      editRate: approved.length ? withEdits / approved.length : null,
      medianMinutes: median(durations),
      averageMinutes: durations.length ? durations.reduce((s, d) => s + d, 0) / durations.length : null,
      oldestPendingMinutes: pendingAges.length ? Math.max(...pendingAges) : null,
    },
    problems,
    ai: {
      inputTokens: all.inputTokens,
      outputTokens: all.outputTokens,
      costUsd: all.costUsd,
      costPerRequest: requests.length ? all.costUsd / requests.length : null,
      readCostUsd: read.costUsd,
      writeCostUsd: write.costUsd,
      rejectedAttempts,
      rejectedAttemptsCostUsd,
      perRequest,
    },
  };
}
