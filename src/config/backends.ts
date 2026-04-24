import { readFileSync } from 'node:fs';
import { parse } from 'smol-toml';
import { z } from 'zod';
import { backendsConfigPath } from '../util/paths.ts';

/**
 * backends.toml schema.
 *
 * Supports three transports:
 *   - stdio: spawn a subprocess (command + args + env)
 *   - http:  Streamable HTTP (POST/GET to a URL)
 *   - sse:   legacy Server-Sent Events
 *
 * Auth is decoupled from this file — the config only declares HOW the token is injected
 * (header name + kind). The actual token is stored encrypted via `mcx auth set`.
 */

const AuthHeaderSchema = z.object({
  kind: z.literal('header'),
  name: z.string().min(1),
});

const AuthBearerSchema = z.object({
  kind: z.literal('bearer'),
});

const AuthOAuthSchema = z.object({
  kind: z.literal('oauth'),
  // Optional discovery overrides — most servers expose .well-known/oauth-authorization-server
  // and we discover automatically. Override only when the server is non-compliant.
  authorization_endpoint: z.string().url().optional(),
  token_endpoint: z.string().url().optional(),
  registration_endpoint: z.string().url().optional(),
  // Pre-registered static client (escape hatch when DCR isn't available)
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
  scope: z.string().optional(),
});

const AuthSchema = z.discriminatedUnion('kind', [
  AuthHeaderSchema,
  AuthBearerSchema,
  AuthOAuthSchema,
]);

const StdioBackendSchema = z.object({
  type: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  timeout_ms: z.number().int().positive().optional(),
  description: z.string().optional(),
});

const HttpBackendSchema = z.object({
  type: z.literal('http'),
  url: z.string().url(),
  auth: AuthSchema.optional(),
  headers: z.record(z.string(), z.string()).default({}),
  timeout_ms: z.number().int().positive().optional(),
  description: z.string().optional(),
});

const SseBackendSchema = z.object({
  type: z.literal('sse'),
  url: z.string().url(),
  auth: AuthSchema.optional(),
  headers: z.record(z.string(), z.string()).default({}),
  timeout_ms: z.number().int().positive().optional(),
  description: z.string().optional(),
});

export const BackendSchema = z.discriminatedUnion('type', [
  StdioBackendSchema,
  HttpBackendSchema,
  SseBackendSchema,
]);

export const BackendsFileSchema = z.object({
  backend: z.record(
    z
      .string()
      .min(1)
      .regex(/^[a-zA-Z0-9_-]+$/, 'backend name must be alphanumeric + dash/underscore'),
    BackendSchema,
  ),
});

export type Backend = z.infer<typeof BackendSchema>;
export type StdioBackend = z.infer<typeof StdioBackendSchema>;
export type HttpBackend = z.infer<typeof HttpBackendSchema>;
export type SseBackend = z.infer<typeof SseBackendSchema>;
export type BackendsFile = z.infer<typeof BackendsFileSchema>;

export function loadBackends(override?: string): BackendsFile {
  const path = backendsConfigPath(override);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      const msg = `backends.toml not found at ${path}\n  Hint: cp examples/backends.toml ${path} and edit.`;
      const wrapped = new Error(msg) as Error & { code?: string };
      wrapped.code = 'config_missing';
      throw wrapped;
    }
    throw e;
  }
  const parsed = parse(raw);
  const result = BackendsFileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    const err = new Error(`backends.toml validation failed:\n${issues}`) as Error & {
      code?: string;
    };
    err.code = 'config_invalid';
    throw err;
  }
  return result.data;
}

export function getBackend(file: BackendsFile, name: string): Backend {
  const b = file.backend[name];
  if (!b) {
    const err = new Error(
      `backend '${name}' not in backends.toml. Known: ${Object.keys(file.backend).join(', ')}`,
    ) as Error & { code?: string };
    err.code = 'backend_unknown';
    throw err;
  }
  return b;
}
