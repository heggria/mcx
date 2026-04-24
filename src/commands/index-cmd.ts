import type { Command } from 'commander';
import { connect, listAllTools } from '../backend/client.ts';
import { loadBackends } from '../config/backends.ts';
import { markServerError, replaceTools } from '../catalog/store.ts';
import { withEnvelope } from '../envelope.ts';
import { writeAudit } from '../audit.ts';
import { callId } from '../util/ids.ts';
import { log } from '../util/log.ts';
import { runEmbed } from './embed.ts';

interface IndexResult {
  servers: Array<{
    name: string;
    transport: string;
    tool_count: number;
    indexed_at: number;
    error?: string;
  }>;
  total_tools: number;
}

export function registerIndexCommand(program: Command): void {
  program
    .command('index')
    .description('rebuild tool catalog by hitting every backend')
    .option('-s, --server <name>', 'only re-index one backend')
    .option('--embed', 'after indexing, run embeddings for any new tools')
    .action(async (opts: { server?: string; embed?: boolean }) => {
      const id = callId();
      const start = Date.now();
      const root = program.opts<{ json?: boolean; config?: string }>();

      const { env } = await withEnvelope<IndexResult>('index', id, root.json, async () => {
        const file = loadBackends(root.config);
        const targets = opts.server
          ? Object.entries(file.backend).filter(([n]) => n === opts.server)
          : Object.entries(file.backend);
        if (opts.server && targets.length === 0) {
          const e = new Error(
            `backend '${opts.server}' not in backends.toml. Known: ${Object.keys(file.backend).join(', ')}`,
          ) as Error & { code?: string };
          e.code = 'backend_unknown';
          throw e;
        }

        const results: IndexResult['servers'] = [];
        let total = 0;

        // Run sequentially: spawning many stdio backends in parallel risks port/pipe
        // contention and confusing log streams. The whole op is local + bounded.
        for (const [name, backend] of targets) {
          if (!root.json) log.info(`indexing ${name} (${backend.type})...`);
          try {
            const conn = await connect(name, backend);
            try {
              const tools = await listAllTools(conn.client);
              const url = backend.type === 'stdio' ? null : backend.url;
              replaceTools(name, backend.type, url, tools);
              total += tools.length;
              results.push({
                name,
                transport: backend.type,
                tool_count: tools.length,
                indexed_at: Date.now(),
              });
              if (!root.json) log.info(`  → ${tools.length} tools`);
            } finally {
              await conn.close();
            }
          } catch (e) {
            const msg = (e as Error).message ?? String(e);
            const url = backend.type === 'stdio' ? null : backend.url;
            markServerError(name, backend.type, url, msg);
            results.push({
              name,
              transport: backend.type,
              tool_count: 0,
              indexed_at: Date.now(),
              error: msg,
            });
            if (!root.json) log.warn(`  ✖ ${name}: ${msg}`);
          }
        }
        return { servers: results, total_tools: total };
      });

      writeAudit({
        call_id: id,
        ts: Date.now(),
        op: 'index',
        status: env.ok ? 'ok' : 'error',
        duration_ms: Date.now() - start,
        results_count: env.data?.total_tools,
      });

      // Auto-embed any newly-indexed tools.
      if (opts.embed && env.ok) {
        await runEmbed({ all: false, json: root.json });
      }
    });
}
