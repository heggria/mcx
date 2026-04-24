import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { exec } from 'node:child_process';
import { openCatalog } from '../catalog/store.ts';
import { log } from '../util/log.ts';

/**
 * OAuth 2.1 client implementation following the MCP Authorization spec
 * (https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
 *
 * Phase 1 of OAuth:
 *   1. Discovery: GET /.well-known/oauth-authorization-server (RFC 8414)
 *      Falls back to /.well-known/oauth-protected-resource for protected resource metadata.
 *   2. Dynamic Client Registration (DCR, RFC 7591): POST to registration_endpoint.
 *      Skipped when backend already has client_id in backends.toml.
 *   3. Authorization Code + PKCE (S256): launch browser + spin up local callback server.
 *   4. Token exchange: POST to token_endpoint.
 *   5. Token refresh on demand.
 *
 * Tokens stored encrypted (auth_tokens table) as JSON: { access_token, refresh_token?,
 * expires_at?, token_type, scope? }. The Bearer access_token is the only thing the
 * backend layer ultimately needs.
 */

const REDIRECT_PORT_PREFERRED = 7654;
const REDIRECT_PATH = '/oauth/callback';

export interface OAuthDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
}

export interface OAuthClient {
  client_id: string;
  client_secret?: string;
  redirect_uri: string;
  scope?: string;
}

export interface OAuthTokenSet {
  access_token: string;
  refresh_token?: string;
  expires_at?: number; // epoch ms
  token_type: string;
  scope?: string;
  /** raw token endpoint response, kept for debugging */
  raw?: unknown;
}

/* ───────────────── Discovery ───────────────── */

/**
 * Discover OAuth endpoints for an MCP server URL.
 * Tries protected-resource metadata first (per MCP spec), then falls back to
 * authorization-server metadata at the resource origin.
 */
export async function discover(serverUrl: string): Promise<OAuthDiscovery> {
  const u = new URL(serverUrl);
  const origin = `${u.protocol}//${u.host}`;

  // Try protected-resource metadata first (the MCP-recommended path).
  try {
    const r = await fetch(`${origin}/.well-known/oauth-protected-resource`);
    if (r.ok) {
      const j = (await r.json()) as { authorization_servers?: string[] };
      const issuer = j.authorization_servers?.[0];
      if (issuer) {
        const meta = await fetchAuthorizationServerMetadata(issuer);
        if (meta) return meta;
      }
    }
  } catch {
    /* fall through */
  }

  // Fallback: AS metadata at the resource origin.
  const meta = await fetchAuthorizationServerMetadata(origin);
  if (meta) return meta;

  // Last resort: OpenID Connect discovery (some servers reuse it).
  try {
    const r = await fetch(`${origin}/.well-known/openid-configuration`);
    if (r.ok) {
      const j = (await r.json()) as Record<string, string | string[]>;
      if (typeof j.authorization_endpoint === 'string' && typeof j.token_endpoint === 'string') {
        return {
          authorization_endpoint: j.authorization_endpoint,
          token_endpoint: j.token_endpoint,
          registration_endpoint:
            typeof j.registration_endpoint === 'string' ? j.registration_endpoint : undefined,
          scopes_supported: Array.isArray(j.scopes_supported)
            ? (j.scopes_supported as string[])
            : undefined,
          code_challenge_methods_supported: Array.isArray(j.code_challenge_methods_supported)
            ? (j.code_challenge_methods_supported as string[])
            : undefined,
        };
      }
    }
  } catch {
    /* fall through */
  }

  const e = new Error(
    `OAuth discovery failed for ${serverUrl}. No /.well-known/oauth-authorization-server, oauth-protected-resource, or openid-configuration found.`,
  ) as Error & { code?: string };
  e.code = 'oauth_discovery_failed';
  throw e;
}

async function fetchAuthorizationServerMetadata(origin: string): Promise<OAuthDiscovery | null> {
  const r = await fetch(`${origin.replace(/\/$/, '')}/.well-known/oauth-authorization-server`);
  if (!r.ok) return null;
  const j = (await r.json()) as Record<string, unknown>;
  if (typeof j.authorization_endpoint !== 'string') return null;
  if (typeof j.token_endpoint !== 'string') return null;
  return {
    authorization_endpoint: j.authorization_endpoint,
    token_endpoint: j.token_endpoint,
    registration_endpoint:
      typeof j.registration_endpoint === 'string' ? j.registration_endpoint : undefined,
    scopes_supported: Array.isArray(j.scopes_supported) ? (j.scopes_supported as string[]) : undefined,
    code_challenge_methods_supported: Array.isArray(j.code_challenge_methods_supported)
      ? (j.code_challenge_methods_supported as string[])
      : undefined,
  };
}

/* ───────────────── Dynamic Client Registration ───────────────── */

export async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
  scope?: string,
): Promise<OAuthClient> {
  const body = {
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: 'none', // public client (PKCE-only)
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_name: 'mcx',
    client_uri: 'https://github.com/heggria/mcx',
    scope: scope ?? '',
  };
  const r = await fetch(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    throw new Error(`DCR failed: ${r.status} ${await r.text()}`);
  }
  const j = (await r.json()) as { client_id: string; client_secret?: string };
  return {
    client_id: j.client_id,
    client_secret: j.client_secret,
    redirect_uri: redirectUri,
    scope,
  };
}

/* ───────────────── PKCE ───────────────── */

export function generatePkce(): { verifier: string; challenge: string; method: 'S256' } {
  // 43-128 chars, URL-safe base64
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

export function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ───────────────── Authorization Code Flow ───────────────── */

export interface AuthorizeResult {
  code: string;
  state: string;
  receivedAt: number;
}

/**
 * Run the full Authorization Code + PKCE flow:
 *   - Spin up a local callback server on REDIRECT_PORT_PREFERRED (or any free port)
 *   - Open the user's browser to the authorization endpoint
 *   - Wait for the redirect to land, validate state, return the code
 */
export async function authorize(
  discovery: OAuthDiscovery,
  client: OAuthClient,
  pkce: { verifier: string; challenge: string; method: 'S256' },
): Promise<AuthorizeResult> {
  const state = base64url(randomBytes(16));

  // Bind a local TCP port for the redirect.
  const { server, port } = await listenOnAnyPort(REDIRECT_PORT_PREFERRED);
  const redirectUri = `http://127.0.0.1:${port}${REDIRECT_PATH}`;
  if (redirectUri !== client.redirect_uri) {
    // We allow port drift only if we can re-register; warn the user.
    log.warn(
      `redirect_uri drift: registered ${client.redirect_uri}, local server bound to ${redirectUri}. If the auth provider rejects this, re-register with mcx auth login --reset.`,
    );
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: redirectUri,
    state,
    code_challenge: pkce.challenge,
    code_challenge_method: pkce.method,
  });
  if (client.scope) params.set('scope', client.scope);
  const authUrl = `${discovery.authorization_endpoint}?${params.toString()}`;

  log.info(`opening browser to: ${authUrl.split('?')[0]}?...`);
  openInBrowser(authUrl);

  try {
    const result = await waitForCallback(server, state);
    return result;
  } finally {
    server.close();
  }
}

function listenOnAnyPort(
  preferred: number,
): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        // Try a random free port.
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          if (typeof addr === 'object' && addr) resolve({ server, port: addr.port });
          else reject(new Error('failed to bind'));
        });
      } else {
        reject(err);
      }
    });
    server.listen(preferred, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr) resolve({ server, port: addr.port });
      else reject(new Error('failed to bind'));
    });
  });
}

function waitForCallback(
  server: ReturnType<typeof createServer>,
  expectedState: string,
): Promise<AuthorizeResult> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('OAuth callback timed out after 5 minutes'));
    }, 5 * 60 * 1000);

    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      if (!req.url || !req.url.startsWith(REDIRECT_PATH)) {
        res.writeHead(404).end('Not Found');
        return;
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');
      const errorDesc = url.searchParams.get('error_description');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' }).end(
          `<h1>Auth failed</h1><p>${escapeHtml(error)}: ${escapeHtml(errorDesc ?? '')}</p>`,
        );
        clearTimeout(timeout);
        reject(new Error(`OAuth error: ${error} - ${errorDesc ?? ''}`));
        return;
      }
      if (!code || !state) {
        res.writeHead(400).end('Missing code or state');
        clearTimeout(timeout);
        reject(new Error('OAuth callback missing code/state'));
        return;
      }
      if (state !== expectedState) {
        res.writeHead(400).end('State mismatch');
        clearTimeout(timeout);
        reject(new Error('OAuth state mismatch — possible CSRF'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' }).end(
        '<h1>✓ Authorized</h1><p>You can close this tab and return to your terminal.</p>',
      );
      clearTimeout(timeout);
      resolve({ code, state, receivedAt: Date.now() });
    });
  });
}

function openInBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? `open "${url}"` :
    process.platform === 'win32' ? `start "" "${url}"` :
    `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) log.warn(`failed to auto-open browser: ${err.message}\n  paste manually: ${url}`);
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default:  return '&#39;';
    }
  });
}

/* ───────────────── Token exchange + refresh ───────────────── */

export async function exchangeCodeForToken(
  tokenEndpoint: string,
  client: OAuthClient,
  code: string,
  pkceVerifier: string,
): Promise<OAuthTokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: client.redirect_uri,
    client_id: client.client_id,
    code_verifier: pkceVerifier,
  });
  if (client.client_secret) body.set('client_secret', client.client_secret);

  const r = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!r.ok) {
    throw new Error(`token exchange failed: ${r.status} ${await r.text()}`);
  }
  const j = (await r.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
  };
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: j.expires_in ? Date.now() + j.expires_in * 1000 : undefined,
    token_type: j.token_type ?? 'Bearer',
    scope: j.scope,
    raw: j,
  };
}

export async function refreshTokenSet(
  tokenEndpoint: string,
  client: OAuthClient,
  refreshToken: string,
): Promise<OAuthTokenSet> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: client.client_id,
  });
  if (client.client_secret) body.set('client_secret', client.client_secret);

  const r = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!r.ok) {
    throw new Error(`token refresh failed: ${r.status} ${await r.text()}`);
  }
  const j = (await r.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
  };
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token ?? refreshToken, // some servers don't rotate
    expires_at: j.expires_in ? Date.now() + j.expires_in * 1000 : undefined,
    token_type: j.token_type ?? 'Bearer',
    scope: j.scope,
    raw: j,
  };
}

/* ───────────────── Persistence: oauth_clients table ───────────────── */

export function saveOAuthClient(
  server: string,
  discovery: OAuthDiscovery,
  client: OAuthClient,
): void {
  openCatalog()
    .prepare(
      `INSERT INTO oauth_clients (server, authorization_endpoint, token_endpoint, registration_endpoint, client_id, client_secret, scope, redirect_uri, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(server) DO UPDATE SET
         authorization_endpoint = excluded.authorization_endpoint,
         token_endpoint = excluded.token_endpoint,
         registration_endpoint = excluded.registration_endpoint,
         client_id = excluded.client_id,
         client_secret = excluded.client_secret,
         scope = excluded.scope,
         redirect_uri = excluded.redirect_uri,
         created_at = excluded.created_at`,
    )
    .run(
      server,
      discovery.authorization_endpoint,
      discovery.token_endpoint,
      discovery.registration_endpoint ?? null,
      client.client_id,
      client.client_secret ?? null,
      client.scope ?? null,
      client.redirect_uri,
      Date.now(),
    );
}

export function loadOAuthClient(
  server: string,
): { discovery: OAuthDiscovery; client: OAuthClient } | null {
  const row = openCatalog()
    .query('SELECT * FROM oauth_clients WHERE server = ?')
    .get(server) as
    | {
        server: string;
        authorization_endpoint: string;
        token_endpoint: string;
        registration_endpoint: string | null;
        client_id: string;
        client_secret: string | null;
        scope: string | null;
        redirect_uri: string;
      }
    | null;
  if (!row) return null;
  return {
    discovery: {
      authorization_endpoint: row.authorization_endpoint,
      token_endpoint: row.token_endpoint,
      registration_endpoint: row.registration_endpoint ?? undefined,
    },
    client: {
      client_id: row.client_id,
      client_secret: row.client_secret ?? undefined,
      redirect_uri: row.redirect_uri,
      scope: row.scope ?? undefined,
    },
  };
}

export function deleteOAuthClient(server: string): boolean {
  const res = openCatalog().prepare('DELETE FROM oauth_clients WHERE server = ?').run(server);
  return res.changes > 0;
}
