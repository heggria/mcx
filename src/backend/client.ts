import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Backend } from '../config/backends.ts';
import { createStdioTransport } from './stdio.ts';
import { createHttpTransport } from './http.ts';
import { createSseTransport } from './sse.ts';
import { log } from '../util/log.ts';

const CLIENT_INFO = { name: 'mcx', version: '0.1.0' };
const CLIENT_OPTIONS = { capabilities: {} };

// Refresh OAuth tokens this many ms before they expire to avoid race conditions.
const REFRESH_BUFFER_MS = 60 * 1000;

export interface ConnectedClient {
  client: Client;
  transport: Transport;
  close: () => Promise<void>;
}

/**
 * Resolve a Bearer token for a backend.
 *
 * Precedence:
 *   1. Env var MCX_TOKEN_<UPPER_SERVER_NAME> (escape hatch for CI/scripts)
 *   2. OAuth-issued token in the encrypted store — auto-refreshed if expired
 *   3. Static Bearer/header token in the encrypted store
 *
 * Returns null when the backend doesn't declare auth at all.
 */
async function resolveAuthToken(serverName: string, backend: Backend): Promise<string | null> {
  if (backend.type === 'stdio') return null;
  if (!backend.auth) return null;

  // Env override.
  const envName = `MCX_TOKEN_${serverName.toUpperCase().replace(/-/g, '_')}`;
  const envVal = process.env[envName];
  if (envVal) return envVal;

  // OAuth path: parse the token set, refresh if expired.
  if (backend.auth.kind === 'oauth') {
    const { decryptTokenSet, setToken } = await import('../auth/store.ts');
    const { loadOAuthClient, refreshTokenSet } = await import('../auth/oauth.ts');
    const set = await decryptTokenSet(serverName);
    if (!set) return null;

    const expiresAt = set.expires_at;
    if (expiresAt && expiresAt < Date.now() + REFRESH_BUFFER_MS) {
      if (!set.refresh_token) {
        log.warn(
          `OAuth token for '${serverName}' is expired but has no refresh_token. Re-run: mcx auth login ${serverName}`,
        );
        return set.access_token; // best-effort: try anyway
      }
      const cached = loadOAuthClient(serverName);
      if (!cached) {
        log.warn(`oauth_clients row missing for '${serverName}'; cannot refresh`);
        return set.access_token;
      }
      try {
        const fresh = await refreshTokenSet(
          cached.discovery.token_endpoint,
          cached.client,
          set.refresh_token,
        );
        setToken(serverName, JSON.stringify(fresh));
        log.debug(`refreshed OAuth token for ${serverName}`);
        return fresh.access_token;
      } catch (e) {
        log.warn(
          `refresh failed for '${serverName}': ${(e as Error).message}. Falling back to stale token; you may need to: mcx auth login ${serverName}`,
        );
        return set.access_token;
      }
    }
    return set.access_token;
  }

  // Static Bearer/header path.
  const { decryptToken } = await import('../auth/store.ts');
  return decryptToken(serverName);
}

export async function connect(serverName: string, backend: Backend): Promise<ConnectedClient> {
  let transport: Transport;
  if (backend.type === 'stdio') {
    transport = createStdioTransport(backend);
  } else {
    const token = await resolveAuthToken(serverName, backend);
    if (backend.auth && !token) {
      const action =
        backend.auth.kind === 'oauth'
          ? `mcx auth login ${serverName}`
          : `mcx auth set ${serverName} --token <value>`;
      const e = new Error(
        `backend '${serverName}' declares auth but no token found. Run: ${action}  (or set $MCX_TOKEN_${serverName.toUpperCase().replace(/-/g, '_')})`,
      ) as Error & { code?: string };
      e.code = 'auth_missing';
      throw e;
    }
    transport =
      backend.type === 'http'
        ? createHttpTransport(backend, token)
        : createSseTransport(backend, token);
  }

  const client = new Client(CLIENT_INFO, CLIENT_OPTIONS);
  await client.connect(transport);

  return {
    client,
    transport,
    close: async () => {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
    },
  };
}

/** Page through `tools/list` until the cursor is exhausted. */
export async function listAllTools(client: Client): Promise<
  Array<{ name: string; description?: string; inputSchema?: unknown }>
> {
  const collected: Array<{ name: string; description?: string; inputSchema?: unknown }> = [];
  let cursor: string | undefined;
  do {
    const res: { tools: typeof collected; nextCursor?: string } = await client.listTools({
      cursor,
    });
    collected.push(...res.tools);
    cursor = res.nextCursor;
  } while (cursor);
  return collected;
}
