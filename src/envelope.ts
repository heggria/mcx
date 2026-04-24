import { log } from './util/log.ts';

/**
 * JSON envelope for CLI output.
 *
 * Activation rules (matching wsc):
 *   1. --json flag (forced on)
 *   2. MCX_JSON=1 env var
 *   3. !process.stdout.isTTY (piped)
 */

export interface Envelope<T = unknown> {
  ok: boolean;
  op: string;
  status: 'ok' | 'degraded' | 'error';
  data?: T;
  error?: { code: string; message: string };
  fallback_chain?: Array<{ from: string; reason: string; error?: string }>;
  duration_ms: number;
  call_id: string;
  correlation_id?: string;
}

export function jsonMode(jsonFlag?: boolean): boolean {
  if (jsonFlag) return true;
  if (process.env.MCX_JSON === '1' || process.env.MCX_JSON === 'true') return true;
  return !process.stdout.isTTY;
}

export function emit<T>(env: Envelope<T>, jsonFlag?: boolean): void {
  if (jsonMode(jsonFlag)) {
    process.stdout.write(`${JSON.stringify(env)}\n`);
    return;
  }
  // Pretty-printed for interactive terminals.
  if (env.ok) {
    process.stdout.write(`${JSON.stringify(env.data, null, 2)}\n`);
  } else {
    log.error(`${env.op} failed: ${env.error?.message ?? 'unknown error'}`);
    if (env.error?.code) log.error(`  code: ${env.error.code}`);
  }
}

/**
 * Run an op with consistent envelope + audit semantics.
 * Catches throws and converts them to error envelopes.
 */
export async function withEnvelope<T>(
  op: string,
  callId: string,
  jsonFlag: boolean | undefined,
  fn: () => Promise<T>,
): Promise<{ env: Envelope<T>; data?: T; error?: unknown }> {
  const start = Date.now();
  try {
    const data = await fn();
    const env: Envelope<T> = {
      ok: true,
      op,
      status: 'ok',
      data,
      duration_ms: Date.now() - start,
      call_id: callId,
      correlation_id: process.env.MCX_CORRELATION_ID || undefined,
    };
    emit(env, jsonFlag);
    return { env, data };
  } catch (e) {
    const err = e as Error & { code?: string };
    const env: Envelope<T> = {
      ok: false,
      op,
      status: 'error',
      error: { code: err.code ?? 'internal_error', message: err.message ?? String(e) },
      duration_ms: Date.now() - start,
      call_id: callId,
      correlation_id: process.env.MCX_CORRELATION_ID || undefined,
    };
    emit(env, jsonFlag);
    return { env, error: e };
  }
}
