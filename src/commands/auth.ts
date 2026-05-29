import type { Command } from 'commander';
import { writeAudit } from '../audit.ts';
import { deleteToken, listTokenServers } from '../auth/bearer.ts';
import {
  authorize,
  deleteOAuthClient,
  discover,
  exchangeCodeForToken,
  generatePkce,
  loadOAuthClient,
  registerClient,
  saveOAuthClient,
} from '../auth/oauth.ts';
import { setToken } from '../auth/store.ts';
import { getBackend, loadBackends } from '../config/backends.ts';
import { withEnvelope } from '../envelope.ts';
import { callId } from '../util/ids.ts';
import { log } from '../util/log.ts';

export function registerAuthCommand(program: Command): void {
  const auth = program.command('auth').description('manage backend auth tokens');

  auth
    .command('set <server>')
    .description('store a Bearer/header token (encrypted at rest)')
    .requiredOption('--token <token>', 'the token value')
    .action(async (server: string, opts: { token: string }) => {
      const id = callId();
      const start = Date.now();
      const root = program.opts<{ json?: boolean }>();
      await withEnvelope('auth.set', id, root.json, async () => {
        setToken(server, opts.token);
        return { server, status: 'stored' };
      });
      writeAudit({
        call_id: id,
        ts: Date.now(),
        op: 'auth.set',
        status: 'ok',
        duration_ms: Date.now() - start,
        server,
      });
    });

  auth
    .command('list')
    .description('list servers with stored tokens')
    .action(async () => {
      const id = callId();
      const root = program.opts<{ json?: boolean }>();
      await withEnvelope('auth.list', id, root.json, async () => {
        return listTokenServers().map((r) => ({
          server: r.server,
          created_at: r.created_at,
          last_used: r.last_used,
        }));
      });
    });

  auth
    .command('rm <server>')
    .description('delete a stored token (and OAuth registration if present)')
    .action(async (server: string) => {
      const id = callId();
      const start = Date.now();
      const root = program.opts<{ json?: boolean }>();
      await withEnvelope('auth.rm', id, root.json, async () => {
        const removedToken = deleteToken(server);
        const removedOAuth = deleteOAuthClient(server);
        return { server, removed_token: removedToken, removed_oauth_client: removedOAuth };
      });
      writeAudit({
        call_id: id,
        ts: Date.now(),
        op: 'auth.rm',
        status: 'ok',
        duration_ms: Date.now() - start,
        server,
      });
    });

  auth
    .command('login <server>')
    .description('OAuth 2.1 login: discover, register (DCR), open browser, store token')
    .option('--reset', 'discard cached client registration before re-running')
    .action(async (server: string, opts: { reset?: boolean }) => {
      const id = callId();
      const start = Date.now();
      const root = program.opts<{ json?: boolean; config?: string }>();

      const { env } = await withEnvelope('auth.login', id, root.json, async () => {
        const file = loadBackends(root.config);
        const backend = getBackend(file, server);
        if (backend.type === 'stdio') {
          throw new Error(`backend '${server}' is stdio — OAuth doesn't apply`);
        }
        if (!backend.auth || backend.auth.kind !== 'oauth') {
          throw new Error(
            `backend '${server}' is not configured for OAuth. Set [backend.${server}.auth] kind = "oauth" in backends.toml`,
          );
        }

        if (opts.reset) {
          deleteOAuthClient(server);
          deleteToken(server);
          if (!root.json) log.info(`reset OAuth state for ${server}`);
        }

        // 1. Discover (or use overrides from backends.toml)
        const cached = loadOAuthClient(server);
        let discovery = cached?.discovery;
        if (!discovery) {
          if (backend.auth.authorization_endpoint && backend.auth.token_endpoint) {
            discovery = {
              authorization_endpoint: backend.auth.authorization_endpoint,
              token_endpoint: backend.auth.token_endpoint,
              registration_endpoint: backend.auth.registration_endpoint,
            };
          } else {
            if (!root.json) log.info(`discovering OAuth endpoints for ${backend.url}...`);
            discovery = await discover(backend.url);
          }
        }

        // 2. Use cached client OR static config OR DCR
        let client = cached?.client;
        if (!client) {
          if (backend.auth.client_id) {
            client = {
              client_id: backend.auth.client_id,
              client_secret: backend.auth.client_secret,
              redirect_uri: 'http://127.0.0.1:7654/oauth/callback',
              scope: backend.auth.scope,
            };
          } else if (discovery.registration_endpoint) {
            if (!root.json)
              log.info(`registering client via DCR (${discovery.registration_endpoint})...`);
            client = await registerClient(
              discovery.registration_endpoint,
              'http://127.0.0.1:7654/oauth/callback',
              backend.auth.scope,
            );
          } else {
            throw new Error(
              `no client_id available: server doesn't expose registration_endpoint and backends.toml has no static client_id`,
            );
          }
          saveOAuthClient(server, discovery, client);
        }

        // 3. PKCE + browser flow
        const pkce = generatePkce();
        if (!root.json) log.info('starting OAuth flow — your browser will open...');
        const cb = await authorize(discovery, client, pkce);

        // 4. Token exchange
        const tokenSet = await exchangeCodeForToken(
          discovery.token_endpoint,
          client,
          cb.code,
          pkce.verifier,
        );

        // 5. Persist (JSON-serialized so refresh_token + expires_at survive)
        setToken(server, JSON.stringify(tokenSet));

        return {
          server,
          access_token_present: !!tokenSet.access_token,
          refresh_token_present: !!tokenSet.refresh_token,
          expires_at: tokenSet.expires_at,
          scope: tokenSet.scope,
          token_type: tokenSet.token_type,
        };
      });

      writeAudit({
        call_id: id,
        ts: Date.now(),
        op: 'auth.login',
        status: env.ok ? 'ok' : 'error',
        duration_ms: Date.now() - start,
        server,
      });
    });
}
