import type { Command } from 'commander';
import { writeAudit } from '../audit.ts';
import { connect, listAllTools } from '../backend/client.ts';
import { defaultSkillRoots, discoverPluginSkillRoots, scanSkillRoot } from '../catalog/skills.ts';
import {
  markServerError,
  markSkillRootError,
  replaceSkills,
  replaceTools,
} from '../catalog/store.ts';
import { loadBackends } from '../config/backends.ts';
import { withEnvelope } from '../envelope.ts';
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
  skill_roots: Array<{
    path: string;
    skill_count: number;
    indexed_at: number;
    errors?: string[];
    error?: string;
  }>;
  total_tools: number;
  total_skills: number;
}

export function registerIndexCommand(program: Command): void {
  program
    .command('index')
    .description('rebuild catalog by hitting MCP backends and/or scanning skill roots')
    .option('-s, --server <name>', 'only re-index one MCP backend')
    .option('--skills', 'also scan skill roots (or only skills if no MCP work specified)')
    .option('--no-tools', 'skip MCP backend indexing (skills only)')
    .option('--root <path>', 'add a skill root to scan (repeatable)', collect, [])
    .option('--embed', 'after indexing, run embeddings for any new entries')
    .action(
      async (opts: {
        server?: string;
        skills?: boolean;
        tools?: boolean; // commander inverts --no-tools
        root?: string[];
        embed?: boolean;
      }) => {
        const id = callId();
        const start = Date.now();
        const root = program.opts<{ json?: boolean; config?: string }>();

        // What are we indexing?
        const wantTools = opts.tools !== false;
        const wantSkills = opts.skills === true || opts.tools === false;

        const { env } = await withEnvelope<IndexResult>('index', id, root.json, async () => {
          const result: IndexResult = {
            servers: [],
            skill_roots: [],
            total_tools: 0,
            total_skills: 0,
          };

          // ── MCP backend indexing (existing behavior) ──
          if (wantTools) {
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

            for (const [name, backend] of targets) {
              if (!root.json) log.info(`indexing ${name} (${backend.type})...`);
              try {
                const conn = await connect(name, backend);
                try {
                  const tools = await listAllTools(conn.client);
                  const url = backend.type === 'stdio' ? null : backend.url;
                  replaceTools(name, backend.type, url, tools);
                  result.total_tools += tools.length;
                  result.servers.push({
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
                result.servers.push({
                  name,
                  transport: backend.type,
                  tool_count: 0,
                  indexed_at: Date.now(),
                  error: msg,
                });
                if (!root.json) log.warn(`  ✖ ${name}: ${msg}`);
              }
            }
          }

          // ── Skill root scanning ──
          if (wantSkills) {
            const explicitRoots = opts.root && opts.root.length > 0 ? opts.root : null;
            const skillRoots = explicitRoots
              ? explicitRoots
              : [...defaultSkillRoots(process.cwd()), ...(await discoverPluginSkillRoots())];

            for (const rootPath of skillRoots) {
              if (!root.json) log.info(`scanning skills in ${rootPath}...`);
              try {
                const scan = await scanSkillRoot(rootPath);
                if (scan.skills.length === 0 && scan.errors.length === 0) {
                  // Empty / nonexistent root — silently skip; don't pollute the catalog.
                  continue;
                }
                const upserted = replaceSkills(rootPath, scan.skills);
                result.total_skills += scan.skills.length;
                const entry: IndexResult['skill_roots'][number] = {
                  path: rootPath,
                  skill_count: upserted.skill_count,
                  indexed_at: upserted.indexed_at ?? Date.now(),
                };
                if (scan.errors.length > 0) entry.errors = scan.errors;
                result.skill_roots.push(entry);
                if (!root.json) log.info(`  → ${scan.skills.length} skills`);
              } catch (e) {
                const msg = (e as Error).message ?? String(e);
                markSkillRootError(rootPath, msg);
                result.skill_roots.push({
                  path: rootPath,
                  skill_count: 0,
                  indexed_at: Date.now(),
                  error: msg,
                });
                if (!root.json) log.warn(`  ✖ ${rootPath}: ${msg}`);
              }
            }
          }

          return result;
        });

        writeAudit({
          call_id: id,
          ts: Date.now(),
          op: 'index',
          status: env.ok ? 'ok' : 'error',
          duration_ms: Date.now() - start,
          results_count: (env.data?.total_tools ?? 0) + (env.data?.total_skills ?? 0),
        });

        if (opts.embed && env.ok) {
          await runEmbed({ all: false, json: root.json });
        }
      },
    );
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
