import type { Command } from 'commander';
import { hashQuery, preview, writeAudit } from '../audit.ts';
import { hybridSearch } from '../catalog/search.ts';
import type { EntityKind } from '../catalog/store.ts';
import { withEnvelope } from '../envelope.ts';
import { callId } from '../util/ids.ts';

export function registerSearchCommand(program: Command): void {
  program
    .command('search <query>')
    .description('hybrid search across cataloged entities (BM25 + embedding rerank)')
    .option('-n, --top <n>', 'top N results', '5')
    .option('-k, --kind <kind>', 'restrict to one kind: tool | skill')
    .option('-s, --server <name>', 'restrict to one MCP backend (implies --kind tool)')
    .option('--rerank-top <n>', 'BM25 candidate pool size before rerank', '20')
    .option('--no-embed', 'pure BM25, skip embedding rerank')
    .option('--full-schema', 'include full input_schema_json in each result (tools only)')
    .action(
      async (
        query: string,
        opts: {
          top?: string;
          kind?: string;
          server?: string;
          rerankTop?: string;
          embed?: boolean;
          fullSchema?: boolean;
        },
      ) => {
        const id = callId();
        const start = Date.now();
        const root = program.opts<{ json?: boolean }>();
        const topN = Math.max(1, Math.min(50, Number(opts.top ?? 5)));
        const rerankTop = Math.max(topN, Math.min(200, Number(opts.rerankTop ?? 20)));

        const kind: EntityKind | undefined = opts.server
          ? 'tool'
          : opts.kind === 'tool' || opts.kind === 'skill'
            ? opts.kind
            : undefined;
        const source = opts.server ? `server:${opts.server}` : undefined;

        const { env } = await withEnvelope('search', id, root.json, async () => {
          const searchOpts: {
            topN: number;
            rerankTop: number;
            kind?: EntityKind;
            source?: string;
            noEmbed?: boolean;
          } = { topN, rerankTop };
          if (kind) searchOpts.kind = kind;
          if (source) searchOpts.source = source;
          if (opts.embed === false) searchOpts.noEmbed = true;
          const out = await hybridSearch(query, searchOpts);

          const results = out.results.map((r) => {
            const e = r.entity;
            const baseAny: Record<string, unknown> = {
              kind: e.kind,
              source: e.source,
              name: e.name,
              description: e.description,
              score: Number(r.score.toFixed(4)),
              bm25_score: r.bm25_score !== null ? Number(r.bm25_score.toFixed(4)) : null,
              cosine: r.cosine !== null ? Number(r.cosine.toFixed(4)) : null,
              rank_source: r.rank_source,
            };

            // Tool-specific fields
            if (e.kind === 'tool') {
              if (e.source.startsWith('server:')) {
                baseAny.server = e.source.slice('server:'.length);
              }
              if (opts.fullSchema && e.input_schema_json) {
                try {
                  baseAny.input_schema = JSON.parse(e.input_schema_json);
                } catch {
                  /* fall through */
                }
              } else if (e.input_schema_json) {
                try {
                  const s = JSON.parse(e.input_schema_json) as {
                    properties?: Record<string, unknown>;
                    required?: string[];
                  };
                  baseAny.args = s.properties ? Object.keys(s.properties) : [];
                  baseAny.required = s.required ?? [];
                } catch {
                  /* fall through */
                }
              }
            } else {
              // Skill-specific fields
              baseAny.body_path = e.body_path;
              baseAny.body_size = e.body_size;
              if (e.triggers) baseAny.triggers = e.triggers;
            }

            return baseAny;
          });

          return {
            query,
            top: topN,
            rerank_top: rerankTop,
            kind: kind ?? 'all',
            embedding_model: out.embedding_model,
            embedded_used: out.embedded_used,
            cosine_fallback_used: out.cosine_fallback_used,
            bm25_hits: out.bm25_hits,
            status: out.status,
            notes: out.notes,
            results,
          };
        });

        writeAudit({
          call_id: id,
          ts: Date.now(),
          op: 'search',
          status: env.ok ? 'ok' : 'error',
          duration_ms: Date.now() - start,
          query_hash: hashQuery(query),
          query_preview: preview(query),
          results_count: env.data?.results?.length ?? 0,
        });
      },
    );
}
