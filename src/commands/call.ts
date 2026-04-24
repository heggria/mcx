import type { Command } from 'commander';
import { connect } from '../backend/client.ts';
import { loadBackends, getBackend } from '../config/backends.ts';
import { findTool } from '../catalog/store.ts';
import { withEnvelope } from '../envelope.ts';
import { callId } from '../util/ids.ts';
import { writeAudit } from '../audit.ts';

export function registerCallCommand(program: Command): void {
  program
    .command('call <server> <tool> [args]')
    .description('invoke a tool on a backend; args is JSON ({} if omitted)')
    .option('--timeout <ms>', 'request timeout in ms', '60000')
    .action(
      async (server: string, tool: string, args: string | undefined, opts: { timeout: string }) => {
        const id = callId();
        const start = Date.now();
        const root = program.opts<{ json?: boolean; config?: string }>();
        const timeoutMs = Math.max(1000, Number(opts.timeout));

        // Permissive arg parsing: accept omitted, '', '{}', or any JSON value.
        let parsedArgs: Record<string, unknown>;
        try {
          parsedArgs =
            args && args.trim().length > 0
              ? (JSON.parse(args) as Record<string, unknown>)
              : {};
          if (parsedArgs === null || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) {
            throw new Error('args must be a JSON object');
          }
        } catch (e) {
          const err = new Error(`failed to parse args as JSON: ${(e as Error).message}`) as Error & {
            code?: string;
          };
          err.code = 'invalid_args';
          throw err;
        }

        const { env } = await withEnvelope('call', id, root.json, async () => {
          const file = loadBackends(root.config);
          const backend = getBackend(file, server);

          // Soft check against the catalog. We still allow calling tools the catalog
          // hasn't seen (newly added on the server side) — just warn rather than block.
          const inCatalog = findTool(server, tool);
          const conn = await connect(server, backend);
          try {
            const result = await conn.client.callTool(
              { name: tool, arguments: parsedArgs },
              undefined,
              { timeout: timeoutMs },
            );
            return {
              server,
              tool,
              cataloged: !!inCatalog,
              isError: result.isError ?? false,
              content: result.content,
              structuredContent: result.structuredContent,
            };
          } finally {
            await conn.close();
          }
        });

        writeAudit({
          call_id: id,
          ts: Date.now(),
          op: 'call',
          status: env.ok ? (env.data?.isError ? 'error' : 'ok') : 'error',
          duration_ms: Date.now() - start,
          server,
          tool,
        });
      },
    );
}
