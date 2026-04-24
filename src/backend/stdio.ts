import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { StdioBackend } from '../config/backends.ts';

export function createStdioTransport(backend: StdioBackend): StdioClientTransport {
  // Pass parent env so PATH / NODE_PATH / API keys (e.g. for npx-fetched servers)
  // are inherited; backend.env overlays.
  // stderr: 'ignore' keeps spawned servers' chatter from polluting our JSON envelope.
  // Set MCX_DEBUG=1 to see the spawned server's stderr for troubleshooting.
  return new StdioClientTransport({
    command: backend.command,
    args: backend.args,
    env: { ...(process.env as Record<string, string>), ...backend.env },
    stderr: process.env.MCX_DEBUG ? 'inherit' : 'ignore',
  });
}
