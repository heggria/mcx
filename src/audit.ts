import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, openSync, statSync } from 'node:fs';
import { auditLogPath, ensureDirs } from './util/paths.ts';

/**
 * JSONL audit log. One line per CLI op.
 * Field shape mirrors wsc so users can build mental models across both tools.
 *
 * Privacy: query_preview is truncated to ~30 chars; full query_hash (sha256) lets you
 * correlate without storing plaintext.
 */

export interface AuditRecord {
  call_id: string;
  parent_call_id?: string;
  correlation_id?: string;
  ts: number;
  op: string;
  status: 'ok' | 'degraded' | 'error';
  duration_ms: number;
  // op-specific
  server?: string;
  tool?: string;
  query_hash?: string;
  query_preview?: string;
  results_count?: number;
  selected_count?: number;
  error_code?: string;
  error_message?: string;
  fallback_chain?: Array<{ from: string; reason: string }>;
}

let cachedFd: number | null = null;

function fd(): number {
  if (cachedFd !== null) return cachedFd;
  ensureDirs();
  cachedFd = openSync(auditLogPath(), 'a', 0o600);
  return cachedFd;
}

export function writeAudit(rec: AuditRecord): void {
  try {
    appendFileSync(fd(), `${JSON.stringify(rec)}\n`);
  } catch (e) {
    // Audit must never crash the caller; emit to stderr only in debug mode.
    if (process.env.MCX_DEBUG) process.stderr.write(`audit write failed: ${e}\n`);
  }
}

export function hashQuery(q: string): string {
  return `sha256:${createHash('sha256').update(q).digest('hex').slice(0, 16)}`;
}

export function preview(q: string, max = 30): string {
  if (q.length <= max) return q;
  return `${q.slice(0, max - 3)}...`;
}

export function auditLogStat(): { exists: boolean; size?: number } {
  try {
    const s = statSync(auditLogPath());
    return { exists: true, size: s.size };
  } catch {
    return { exists: false };
  }
}

// On exit, close the fd cleanly so no audit lines are lost.
process.on('exit', () => {
  if (cachedFd !== null) {
    try {
      closeSync(cachedFd);
    } catch {
      /* ignore */
    }
  }
});
