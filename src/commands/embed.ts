import type { Command } from 'commander';
import { embeddableText, getEmbedder } from '../catalog/embed.ts';
import {
  embeddingStats,
  listTools,
  toolsMissingEmbedding,
  upsertEmbedding,
} from '../catalog/store.ts';
import { withEnvelope } from '../envelope.ts';
import { writeAudit } from '../audit.ts';
import { callId } from '../util/ids.ts';
import { log } from '../util/log.ts';

interface EmbedResult {
  model: string;
  dim: number;
  total_tools: number;
  embedded_now: number;
  embedded_total: number;
  duration_ms: number;
  models_in_db: Array<{ model: string; count: number }>;
}

/**
 * Generate embeddings for cataloged tools.
 * Default behavior (incremental): only tools missing an embedding for the active model.
 * --all forces re-embedding everything.
 */
export async function runEmbed(opts: {
  all?: boolean;
  json?: boolean;
}): Promise<{ env: { ok: boolean; data?: EmbedResult }; data?: EmbedResult }> {
  const id = callId();
  const start = Date.now();

  const result = await withEnvelope<EmbedResult>('embed', id, opts.json, async () => {
    const embedder = await getEmbedder();
    const targets = opts.all
      ? listTools()
      : toolsMissingEmbedding(embedder.model);

    if (targets.length === 0) {
      const stats = embeddingStats(embedder.model);
      return {
        model: embedder.model,
        dim: embedder.dim,
        total_tools: stats.total_tools,
        embedded_now: 0,
        embedded_total: stats.embedded,
        duration_ms: Date.now() - start,
        models_in_db: stats.models,
      };
    }

    if (!opts.json) log.info(`embedding ${targets.length} tools with ${embedder.model}...`);

    // Batch in groups of 16 — small enough that local model RAM stays bounded,
    // big enough to amortize per-call overhead on hosted providers.
    const BATCH = 16;
    let done = 0;
    for (let i = 0; i < targets.length; i += BATCH) {
      const chunk = targets.slice(i, i + BATCH);
      const texts = chunk.map((t) => embeddableText(t));
      const vecs = await embedder.embed(texts, 'passage');
      for (let j = 0; j < chunk.length; j++) {
        const tool = chunk[j];
        const v = vecs[j];
        if (tool && v) upsertEmbedding(tool.id, embedder.model, v);
      }
      done += chunk.length;
      if (!opts.json) log.info(`  ${done}/${targets.length}`);
    }

    const stats = embeddingStats(embedder.model);
    return {
      model: embedder.model,
      dim: embedder.dim,
      total_tools: stats.total_tools,
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
    .description('generate embeddings for cataloged tools (incremental by default)')
    .option('--all', 're-embed every tool, not just the missing ones')
    .action(async (opts: { all?: boolean }) => {
      const root = program.opts<{ json?: boolean }>();
      await runEmbed({ all: opts.all, json: root.json });
    });
}
