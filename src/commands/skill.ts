import type { Command } from 'commander';
import { writeAudit } from '../audit.ts';
import { findEntity, listEntities } from '../catalog/store.ts';
import { withEnvelope } from '../envelope.ts';
import { callId } from '../util/ids.ts';

interface SkillShowResult {
  name: string;
  source: string;
  description: string | null;
  triggers: string | null;
  body_path: string | null;
  body_size: number | null;
  body?: string;
}

interface SkillListResult {
  skills: Array<{
    name: string;
    source: string;
    description: string | null;
    body_size: number | null;
    body_path: string | null;
  }>;
}

/**
 * `mcx skill show <name>`
 *   By default reads SKILL.md body off disk and returns it as `body`.
 *   `--meta-only` skips the body and returns just the metadata row.
 *
 * `mcx skill list`
 *   Lists all cataloged skills (does not read bodies).
 */
export function registerSkillCommand(program: Command): void {
  const skill = program.command('skill').description('inspect cataloged skills');

  skill
    .command('show <name>')
    .description('show a cataloged skill by name (reads SKILL.md body unless --meta-only)')
    .option('--source <s>', 'disambiguate by source (e.g. "skill-root:1")')
    .option('--meta-only', 'do not read the body file, just return the metadata row')
    .action(async (name: string, opts: { source?: string; metaOnly?: boolean }) => {
      const id = callId();
      const start = Date.now();
      const root = program.opts<{ json?: boolean }>();

      await withEnvelope<SkillShowResult>('skill.show', id, root.json, async () => {
        const e = findEntity('skill', name, opts.source);
        if (!e) {
          const err = new Error(
            `skill '${name}'${opts.source ? ` in ${opts.source}` : ''} not in catalog. Run: mcx index --skills`,
          );
          (err as Error & { code?: string }).code = 'skill_unknown';
          throw err;
        }
        const result: SkillShowResult = {
          name: e.name,
          source: e.source,
          description: e.description,
          triggers: e.triggers,
          body_path: e.body_path,
          body_size: e.body_size,
        };
        if (!opts.metaOnly && e.body_path) {
          try {
            result.body = await Bun.file(e.body_path).text();
          } catch (readErr) {
            const err = new Error(
              `failed to read SKILL.md at ${e.body_path}: ${(readErr as Error).message}`,
            );
            (err as Error & { code?: string }).code = 'skill_read_failed';
            throw err;
          }
        }
        return result;
      });

      writeAudit({
        call_id: id,
        ts: Date.now(),
        op: 'skill.show',
        status: 'ok',
        duration_ms: Date.now() - start,
        server: name, // reuse the field for the skill name so receipts surface it
      });
    });

  skill
    .command('list')
    .description('list cataloged skills')
    .option('--source <s>', 'restrict to one source (e.g. "skill-root:1")')
    .action(async (opts: { source?: string }) => {
      const id = callId();
      const start = Date.now();
      const root = program.opts<{ json?: boolean }>();

      await withEnvelope<SkillListResult>('skill.list', id, root.json, async () => {
        const listOpts: { kind: 'skill'; source?: string } = { kind: 'skill' };
        if (opts.source) listOpts.source = opts.source;
        const ents = listEntities(listOpts);
        return {
          skills: ents.map((e) => ({
            name: e.name,
            source: e.source,
            description: e.description,
            body_size: e.body_size,
            body_path: e.body_path,
          })),
        };
      });

      writeAudit({
        call_id: id,
        ts: Date.now(),
        op: 'skill.list',
        status: 'ok',
        duration_ms: Date.now() - start,
      });
    });
}
