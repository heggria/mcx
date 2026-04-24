import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { HttpBackend } from '../config/backends.ts';

export function createHttpTransport(
  backend: HttpBackend,
  authToken: string | null,
): StreamableHTTPClientTransport {
  const headers: Record<string, string> = { ...backend.headers };
  if (authToken && backend.auth) {
    if (backend.auth.kind === 'header') {
      headers[backend.auth.name] = authToken;
    } else if (backend.auth.kind === 'bearer' || backend.auth.kind === 'oauth') {
      headers.Authorization = `Bearer ${authToken}`;
    }
  }
  return new StreamableHTTPClientTransport(new URL(backend.url), {
    requestInit: { headers },
  });
}
