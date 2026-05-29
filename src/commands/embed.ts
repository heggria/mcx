import type { Command } from 'commander';
import { writeAudit } from '../audit.ts';
import { embeddableText, getEmbedder } from '../catalog/embed.ts';
import {
  type EntityKind,
  embeddingStats,
  entitiesMissingEmbedding,
  listEntities,
  upsertEmbedding,
} from '../catalog/store.ts';
import { withEnvelope } from '../envelope.ts';
import { callId } from '../util/ids.ts';
import { log } from '../util/log.ts';

interface EmbedResult {
  model: string;
  dim: number;
  total_entities: number;
  total_tools: number;
  total_skills: number;
  embedded_now: number;
  embedded_total: number;
  duration_ms: number;
  models_in_db: Array<{ model: string; count: number }>;
}

/**
 * Generate embeddings for cataloged entities (tools + skills).
 * Default behavior (incremental): only entities missing an embedding for the active model.
 * --all forces re-embedding everything.
 * --kind tool|skill restricts to one kind.
 */
export async function runEmbed(opts: {
  all?: boolean;
  kind?: EntityKind;
  json?: boolean;
}): Promise<{ env: { ok: boolean; data?: EmbedResult }; data?: EmbedResult }> {
  const id = callId();
  const start = Date.now();

  const result = await withEnvelope<EmbedResult>('embed', id, opts.json, async () => {
    const embedder = await getEmbedder();
    const targets = opts.all
      ? listEntities(opts.kind ? { kind: opts.kind } : {})
      : entitiesMissingEmbedding(embedder.model, opts.kind);

    if (targets.length === 0) {
      const stats = embeddingStats(embedder.model);
      return {
        model: embedder.model,
        dim: embedder.dim,
        total_entities: stats.total_entities,
        total_tools: stats.total_tools,
        total_skills: stats.total_skills,
        embedded_now: 0,
        embedded_total: stats.embedded,
        duration_ms: Date.now() - start,
        models_in_db: stats.models,
      };
    }

    if (!opts.json) {
      const kindLabel = opts.kind ?? 'entit';
      log.info(
        `embedding ${targets.length} ${kindLabel}${opts.kind ? 's' : 'ies'} with ${embedder.model}...`,
      );
    }

    const BATCH = 16;
    let done = 0;
    for (let i = 0; i < targets.length; i += BATCH) {
      const chunk = targets.slice(i, i + BATCH);
      const texts = chunk.map((t) => embeddableText(t));
      const vecs = await embedder.embed(texts, 'passage');
      for (let j = 0; j < chunk.length; j++) {
        const ent = chunk[j];
        const v = vecs[j];
        if (ent && v) upsertEmbedding(ent.id, embedder.model, v);
      }
      done += chunk.length;
      if (!opts.json) log.info(`  ${done}/${targets.length}`);
    }

    const stats = embeddingStats(embedder.model);
    return {
      model: embedder.model,
      dim: embedder.dim,
      total_entities: stats.total_entities,
      total_tools: stats.total_tools,
      total_skills: stats.total_skills,
      embedded_now: targets.length,
      embedded_total: stats.embedded,
      duration_ms: Date.now() - start,
      models_in_db: stats.models,
    };
  });

  writeAudit({
    call_id: id,
    ts: Date.now(),
    op: 'embed',
    status: result.env.ok ? 'ok' : 'error',
    duration_ms: Date.now() - start,
    results_count: result.env.data?.embedded_now,
  });
  return result as { env: { ok: boolean; data?: EmbedResult }; data?: EmbedResult };
}

export function registerEmbedCommand(program: Command): void {
  program
    .command('embed')
    .description('generate embeddings for cataloged entities (incremental by default)')
    .option('--all', 're-embed every entity, not just the missing ones')
    .option('--kind <kind>', 'restrict to one kind: tool | skill')
    .action(async (opts: { all?: boolean; kind?: string }) => {
      const root = program.opts<{ json?: boolean }>();
      const kind = opts.kind === 'tool' || opts.kind === 'skill' ? opts.kind : undefined;
      const callOpts: { all?: boolean; kind?: EntityKind; json?: boolean } = {};
      if (opts.all) callOpts.all = true;
      if (kind) callOpts.kind = kind;
      if (root.json) callOpts.json = true;
      await runEmbed(callOpts);
    });
}
