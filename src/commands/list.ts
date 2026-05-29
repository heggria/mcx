import type { Command } from 'commander';
import { writeAudit } from '../audit.ts';
import { type EntityKind, listEntities, listServers, listSkillRoots } from '../catalog/store.ts';
import { withEnvelope } from '../envelope.ts';
import { callId } from '../util/ids.ts';

export function registerListCommand(program: Command): void {
  program
    .command('list')
    .description('list cataloged servers, skill roots, and entities')
    .option('-s, --server <name>', 'show tools for one MCP server only')
    .option('-k, --kind <kind>', 'restrict entities to one kind: tool | skill')
    .option('--tools-only', 'only print entities (tools+skills), omit server/root summary')
    .option('--entities-only', 'alias for --tools-only (preferred phrasing)')
    .action(
      async (opts: {
        server?: string;
        kind?: string;
        toolsOnly?: boolean;
        entitiesOnly?: boolean;
      }) => {
        const id = callId();
        const start = Date.now();
        const root = program.opts<{ json?: boolean }>();
        const kind: EntityKind | undefined =
          opts.kind === 'tool' || opts.kind === 'skill' ? opts.kind : undefined;
        const minimal = !!(opts.toolsOnly || opts.entitiesOnly || opts.server);

        await withEnvelope('list', id, root.json, async () => {
          const listOpts: { kind?: EntityKind; source?: string } = {};
          if (kind) listOpts.kind = kind;
          if (opts.server) {
            listOpts.kind = 'tool';
            listOpts.source = `server:${opts.server}`;
          }
          const entities = listEntities(listOpts).map((e) => ({
            kind: e.kind,
            source: e.source,
            name: e.name,
            description: e.description,
            ...(e.kind === 'skill' && {
              body_path: e.body_path,
              body_size: e.body_size,
            }),
          }));

          if (minimal) {
            return { entities };
          }

          return {
            servers: listServers(),
            skill_roots: listSkillRoots(),
            entities,
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
      },
    );
}
