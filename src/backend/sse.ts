import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { SseBackend } from '../config/backends.ts';

export function createSseTransport(
  backend: SseBackend,
  authToken: string | null,
): SSEClientTransport {
  const headers: Record<string, string> = { ...backend.headers };
  if (authToken && backend.auth) {
    if (backend.auth.kind === 'header') {
      headers[backend.auth.name] = authToken;
    } else if (backend.auth.kind === 'bearer' || backend.auth.kind === 'oauth') {
      headers.Authorization = `Bearer ${authToken}`;
    }
  }
  // The MCP SDK's SSE transport uses the `eventsource` npm package, which
  // supports custom headers via the fetch override. Passing requestInit.headers
  // covers both the POST (send) leg and the GET stream (via _commonHeaders).
  return new SSEClientTransport(new URL(backend.url), {
    requestInit: { headers },
  });
}
