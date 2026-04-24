import type { Command } from 'commander';
import { listServers, listTools } from '../catalog/store.ts';
import { withEnvelope } from '../envelope.ts';
import { callId } from '../util/ids.ts';
import { writeAudit } from '../audit.ts';

export function registerListCommand(program: Command): void {
  program
    .command('list')
    .description('list cataloged servers and tools')
    .option('-s, --server <name>', 'show tools for one server only')
    .option('--tools-only', 'only print tools, omit server summary')
    .action(async (opts: { server?: string; toolsOnly?: boolean }) => {
      const id = callId();
      const start = Date.now();
      const root = program.opts<{ json?: boolean }>();
      await withEnvelope('list', id, root.json, async () => {
        if (opts.toolsOnly || opts.server) {
          const tools = listTools(opts.server).map((t) => ({
            server: t.server,
            name: t.name,
            description: t.description,
          }));
          return { tools };
        }
        return {
          servers: listServers(),
          tools: listTools().map((t) => ({
            server: t.server,
            name: t.name,
            description: t.description,
          })),
        };
      });
      writeAudit({
        call_id: id,
        ts: Date.now(),
        op: 'list',
        status: 'ok',
        duration_ms: Date.now() - start,
        server: opts.server,
      });
    });
}
