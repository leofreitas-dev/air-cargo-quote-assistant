import { totalUsage } from '../ai/call.ts';
import type { StoredRequest } from '../store/db.ts';

/** Tokens and cost of every AI call for a stored request (reading + writing). */
export function requestAiTotalsStored(r: StoredRequest) {
  return totalUsage(r.aiRead, r.aiWrite);
}
