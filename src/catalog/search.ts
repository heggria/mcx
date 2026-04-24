import { cosine, getEmbedder } from './embed.ts';
import {
  allEmbeddings,
  embeddingStats,
  getEmbeddings,
  getToolsByIds,
  searchTools as bm25Search,
  type ToolRow,
} from './store.ts';

/**
 * Hybrid search: BM25 candidates → embedding rerank → top-N.
 *
 * Strategy:
 *   1. BM25 over FTS5 picks `rerankTop` candidates fast (works for English keywords).
 *   2. If embeddings are available for the active model, embed the query and rerank.
 *   3. If BM25 returned fewer than `topN` (common for Chinese / out-of-vocab queries),
 *      fall back to pure cosine over the entire embedded catalog.
 *
 * Each result reports:
 *   - score (the final ranking score: cosine when reranked, BM25 otherwise)
 *   - bm25_score (always present when the tool came from BM25)
 *   - cosine (present when the tool was embedded)
 *   - rank_source: 'hybrid' | 'cosine_only' | 'bm25_only'
 */

export interface HybridResult {
  tool: ToolRow;
  score: number;
  bm25_score: number | null;
  cosine: number | null;
  rank_source: 'hybrid' | 'cosine_only' | 'bm25_only';
}

export interface HybridOptions {
  topN?: number;
  rerankTop?: number;
  server?: string;
  noEmbed?: boolean;
}

export interface HybridStatus {
  results: HybridResult[];
  bm25_hits: number;
  embedded_used: boolean;
  cosine_fallback_used: boolean;
  embedding_model: string | null;
  status: 'ok' | 'degraded';
  notes: string[];
}

export async function hybridSearch(query: string, opts: HybridOptions = {}): Promise<HybridStatus> {
  const topN = Math.max(1, Math.min(50, opts.topN ?? 5));
  const rerankTop = Math.max(topN, Math.min(200, opts.rerankTop ?? 20));
  const notes: string[] = [];

  const bm25 = bm25Search(query, { topN: rerankTop, server: opts.server });

  // Pure-BM25 mode (explicit opt-out OR no embeddings ever generated).
  if (opts.noEmbed) {
    return {
      results: bm25.slice(0, topN).map((r) => {
        // Strip the score field from the joined row for cleanliness.
        const { score, ...tool } = r;
        return {
          tool: tool as ToolRow,
          score,
          bm25_score: score,
          cosine: null,
          rank_source: 'bm25_only',
        };
      }),
      bm25_hits: bm25.length,
      embedded_used: false,
      cosine_fallback_used: false,
      embedding_model: null,
      status: 'ok',
      notes: ['embedding rerank disabled by --no-embed'],
    };
  }

  // Discover embedder + model availability without paying for the model load
  // until we know we'll actually use it.
  let embedder: Awaited<ReturnType<typeof getEmbedder>> | null = null;
  let stats = embeddingStats();
  if (stats.embedded === 0) {
    notes.push('no embeddings in catalog — falling back to BM25 only. Run: mcx embed');
    return {
      results: bm25.slice(0, topN).map((r) => {
        const { score, ...tool } = r;
        return {
          tool: tool as ToolRow,
          score,
          bm25_score: score,
          cosine: null,
          rank_source: 'bm25_only',
        };
      }),
      bm25_hits: bm25.length,
      embedded_used: false,
      cosine_fallback_used: false,
      embedding_model: null,
      status: 'degraded',
      notes,
    };
  }

  embedder = await getEmbedder();
  stats = embeddingStats(embedder.model);
  if (stats.embedded === 0) {
    notes.push(
      `no embeddings for active model '${embedder.model}'. Switch model or run: mcx embed`,
    );
    // Best effort: BM25 only.
    return {
      results: bm25.slice(0, topN).map((r) => {
        const { score, ...tool } = r;
        return {
          tool: tool as ToolRow,
          score,
          bm25_score: score,
          cosine: null,
          rank_source: 'bm25_only',
        };
      }),
      bm25_hits: bm25.length,
      embedded_used: false,
      cosine_fallback_used: false,
      embedding_model: embedder.model,
      status: 'degraded',
      notes,
    };
  }

  const [queryVec] = await embedder.embed([query], 'query');
  if (!queryVec) throw new Error('embedder returned no vector for query');

  // Path A: BM25 produced enough candidates → rerank just them.
  if (bm25.length >= topN) {
    const ids = bm25.map((r) => r.id);
    const embeds = getEmbeddings(ids, embedder.model);
    const bm25ById = new Map(bm25.map((r) => [r.id, r]));

    const reranked: HybridResult[] = bm25.map((r) => {
      const v = embeds.get(r.id);
      const c = v ? cosine(queryVec, v) : null;
      const { score, ...tool } = r;
      return {
        tool: tool as ToolRow,
        score: c ?? score, // prefer cosine when present
        bm25_score: score,
        cosine: c,
        rank_source: c !== null ? 'hybrid' : 'bm25_only',
      };
    });
    // Sort: rows with cosine first (descending), then BM25-only by ascending bm25 score.
    reranked.sort((a, b) => {
      if (a.cosine !== null && b.cosine !== null) return b.cosine - a.cosine;
      if (a.cosine !== null) return -1;
      if (b.cosine !== null) return 1;
      return (a.bm25_score ?? 0) - (b.bm25_score ?? 0);
    });
    return {
      results: reranked.slice(0, topN),
      bm25_hits: bm25.length,
      embedded_used: true,
      cosine_fallback_used: false,
      embedding_model: embedder.model,
      status: 'ok',
      notes,
    };
  }

  // Path B: BM25 returned too few (e.g. Chinese query) → cosine over all embeddings.
  const all = allEmbeddings(embedder.model);
  const scored = all.map((e) => ({ tool_id: e.tool_id, cosine: cosine(queryVec, e.vec) }));
  scored.sort((a, b) => b.cosine - a.cosine);
  const top = scored.slice(0, topN);
  const tools = getToolsByIds(top.map((s) => s.tool_id));
  const bm25Score = new Map(bm25.map((r) => [r.id, r.score]));

  return {
    results: top.map((s) => {
      const tool = tools.find((t) => t.id === s.tool_id);
      if (!tool) throw new Error(`tool ${s.tool_id} disappeared from catalog mid-search`);
      const bm = bm25Score.get(s.tool_id) ?? null;
      return {
        tool,
        score: s.cosine,
        bm25_score: bm,
        cosine: s.cosine,
        rank_source: bm !== null ? 'hybrid' : 'cosine_only',
      };
    }),
    bm25_hits: bm25.length,
    embedded_used: true,
    cosine_fallback_used: true,
    embedding_model: embedder.model,
    status: 'ok',
    notes: bm25.length === 0 ? [...notes, 'BM25 had 0 hits — cosine-only ranking'] : notes,
  };
}
