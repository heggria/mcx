import type { Command } from 'commander';
import { hybridSearch } from '../catalog/search.ts';
import { withEnvelope } from '../envelope.ts';
import { callId } from '../util/ids.ts';
import { hashQuery, preview, writeAudit } from '../audit.ts';

export function registerSearchCommand(program: Command): void {
  program
    .command('search <query>')
    .description('hybrid search across cataloged tools (BM25 + embedding rerank)')
    .option('-n, --top <n>', 'top N results', '5')
    .option('-s, --server <name>', 'restrict to one backend')
    .option('--rerank-top <n>', 'BM25 candidate pool size before rerank', '20')
    .option('--no-embed', 'pure BM25, skip embedding rerank')
    .option('--full-schema', 'include full input_schema_json in each result')
    .action(
      async (
        query: string,
        opts: {
          top?: string;
          server?: string;
          rerankTop?: string;
          embed?: boolean; // commander inverts --no-embed → embed = false
          fullSchema?: boolean;
        },
      ) => {
        const id = callId();
        const start = Date.now();
        const root = program.opts<{ json?: boolean }>();
        const topN = Math.max(1, Math.min(50, Number(opts.top ?? 5)));
        const rerankTop = Math.max(topN, Math.min(200, Number(opts.rerankTop ?? 20)));

        const { env } = await withEnvelope('search', id, root.json, async () => {
          const out = await hybridSearch(query, {
            topN,
            rerankTop,
            server: opts.server,
            noEmbed: opts.embed === false,
          });

          const results = out.results.map((r) => {
            const base = {
              server: r.tool.server,
              name: r.tool.name,
              description: r.tool.description,
              score: Number(r.score.toFixed(4)),
              bm25_score: r.bm25_score !== null ? Number(r.bm25_score.toFixed(4)) : null,
              cosine: r.cosine !== null ? Number(r.cosine.toFixed(4)) : null,
              rank_source: r.rank_source,
            };
            if (opts.fullSchema && r.tool.input_schema_json) {
              try {
                return { ...base, input_schema: JSON.parse(r.tool.input_schema_json) };
              } catch {
                /* fall through */
              }
            }
            if (r.tool.input_schema_json) {
              try {
                const s = JSON.parse(r.tool.input_schema_json) as {
                  properties?: Record<string, unknown>;
                  required?: string[];
                };
                return {
                  ...base,
                  args: s.properties ? Object.keys(s.properties) : [],
                  required: s.required ?? [],
                };
              } catch {
                /* fall through */
              }
            }
            return base;
          });

          return {
            query,
            top: topN,
            rerank_top: rerankTop,
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
