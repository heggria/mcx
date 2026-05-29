import { cosine, getEmbedder } from './embed.ts';
import { rerank as llmRerank } from './rerank.ts';
import {
  type EntityKind,
  type EntityRow,
  allEmbeddings,
  embeddingStats,
  getEmbeddings,
  getEntitiesByIds,
  searchEntities,
} from './store.ts';

/**
 * Hybrid search over the unified entity catalog (tools + skills).
 *
 * Strategy:
 *   1. BM25 over FTS5 picks `rerankTop` candidates fast (works for English keywords).
 *   2. If embeddings are available for the active model, embed the query and rerank.
 *   3. If BM25 returned fewer than `topN` (common for Chinese / out-of-vocab queries),
 *      fall back to pure cosine over the entire embedded catalog.
 *
 * Each result reports:
 *   - score (the final ranking score: cosine when reranked, BM25 otherwise)
 *   - bm25_score (always present when the entity came from BM25)
 *   - cosine (present when the entity was embedded)
 *   - rank_source: 'hybrid' | 'cosine_only' | 'bm25_only'
 */

export interface HybridResult {
  entity: EntityRow;
  score: number;
  bm25_score: number | null;
  cosine: number | null;
  rank_source: 'hybrid' | 'cosine_only' | 'bm25_only';
  /** When set, the LLM reranker bumped this row to this 0-indexed position. */
  reranked_to?: number;
}

export interface HybridOptions {
  topN?: number;
  rerankTop?: number;
  kind?: EntityKind;
  source?: string;
  noEmbed?: boolean;
  /** When true, run a second-stage LLM rerank over the top-K candidates. */
  rerank?: boolean;
  /** Override rerank candidate pool size (default: max(topN, 10)). */
  rerankPool?: number;
}

export interface HybridStatus {
  results: HybridResult[];
  bm25_hits: number;
  embedded_used: boolean;
  cosine_fallback_used: boolean;
  embedding_model: string | null;
  status: 'ok' | 'degraded';
  notes: string[];
  /** Set when LLM rerank ran. Includes ok/duration/error. */
  rerank?: { ok: boolean; duration_ms: number; pool_size: number; error?: string };
}

export async function hybridSearch(query: string, opts: HybridOptions = {}): Promise<HybridStatus> {
  const status = await hybridSearchInner(query, opts);

  // Optional second-stage LLM rerank. We only run it when the caller asks for it
  // (`opts.rerank: true`) AND the inner search produced ≥2 candidates. The
  // reranker is a wrapper over the existing `results` array — it doesn't
  // re-fetch anything, just consults an LLM to reorder candidates the search
  // already found.
  if (!opts.rerank || status.results.length < 2) return status;

  const poolSize = Math.min(status.results.length, opts.rerankPool ?? Math.max(opts.topN ?? 5, 10));
  const pool = status.results.slice(0, poolSize);
  const candidates = pool.map((r) => ({
    name: r.entity.name,
    description: r.entity.description,
    score: r.score,
  }));
  const rr = await llmRerank(query, candidates);
  status.rerank = {
    ok: rr.ok,
    duration_ms: rr.duration_ms,
    pool_size: poolSize,
    ...(rr.error && { error: rr.error }),
  };
  if (!rr.ok) {
    // Keep original ordering on rerank failure.
    return status;
  }

  // Reorder pool based on llmRanked, append the un-reranked tail unchanged.
  const byName = new Map(pool.map((r) => [r.entity.name, r]));
  const reorderedPool: HybridResult[] = [];
  rr.ranked.forEach((name, idx) => {
    const r = byName.get(name);
    if (r) reorderedPool.push({ ...r, reranked_to: idx });
  });
  // Safety net: include any pool entry the LLM dropped (shouldn't happen).
  for (const r of pool) {
    if (!reorderedPool.find((x) => x.entity.name === r.entity.name)) {
      reorderedPool.push(r);
    }
  }
  const tail = status.results.slice(poolSize);
  status.results = [...reorderedPool, ...tail];
  return status;
}

async function hybridSearchInner(query: string, opts: HybridOptions = {}): Promise<HybridStatus> {
  const topN = Math.max(1, Math.min(50, opts.topN ?? 5));
  const rerankTop = Math.max(topN, Math.min(200, opts.rerankTop ?? 50));
  const notes: string[] = [];

  const bm25Opts: { topN: number; kind?: EntityKind; source?: string } = { topN: rerankTop };
  if (opts.kind) bm25Opts.kind = opts.kind;
  if (opts.source) bm25Opts.source = opts.source;

  // CJK-heavy queries: the unicode61 tokenizer can't split "飞书消息" so BM25
  // routinely returns 0 hits for Chinese-only input. Skip BM25 entirely and
  // go straight to cosine — same end result, half the work.
  const cjkHeavy = isCjkHeavyQuery(query);
  const bm25 = cjkHeavy ? [] : searchEntities(query, bm25Opts);
  if (cjkHeavy) notes.push('CJK-heavy query — skipped BM25, going straight to cosine');

  if (opts.noEmbed) {
    return {
      results: bm25.slice(0, topN).map((r) => {
        const { score, ...entity } = r;
        return {
          entity: entity as EntityRow,
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

  let stats = embeddingStats();
  if (stats.embedded === 0) {
    notes.push('no embeddings in catalog — falling back to BM25 only. Run: mcx embed');
    return {
      results: bm25.slice(0, topN).map((r) => {
        const { score, ...entity } = r;
        return {
          entity: entity as EntityRow,
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

  const embedder = await getEmbedder();
  stats = embeddingStats(embedder.model);
  if (stats.embedded === 0) {
    notes.push(
      `no embeddings for active model '${embedder.model}'. Switch model or run: mcx embed`,
    );
    return {
      results: bm25.slice(0, topN).map((r) => {
        const { score, ...entity } = r;
        return {
          entity: entity as EntityRow,
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

    const reranked: HybridResult[] = bm25.map((r) => {
      const v = embeds.get(r.id);
      const c = v ? cosine(queryVec, v) : null;
      const { score, ...entity } = r;
      return {
        entity: entity as EntityRow,
        score: c ?? score,
        bm25_score: score,
        cosine: c,
        rank_source: c !== null ? 'hybrid' : 'bm25_only',
      };
    });
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

  // Path B: BM25 returned too few → cosine over all embeddings (optionally kind-filtered).
  const all = allEmbeddings(embedder.model, opts.kind);
  const scored = all.map((e) => ({ entity_id: e.entity_id, cosine: cosine(queryVec, e.vec) }));
  scored.sort((a, b) => b.cosine - a.cosine);
  // Take a few extra so post-filter (source) still has room to fill topN.
  const top = scored.slice(0, topN * 3);
  const entities = getEntitiesByIds(top.map((s) => s.entity_id));
  const bm25Score = new Map(bm25.map((r) => [r.id, r.score]));

  const results = top
    .map((s) => {
      const entity = entities.find((t) => t.id === s.entity_id);
      if (!entity) return null;
      if (opts.source && entity.source !== opts.source) return null;
      const bm = bm25Score.get(s.entity_id) ?? null;
      return {
        entity,
        score: s.cosine,
        bm25_score: bm,
        cosine: s.cosine,
        rank_source: bm !== null ? 'hybrid' : 'cosine_only',
      } as HybridResult;
    })
    .filter((r): r is HybridResult => r !== null)
    .slice(0, topN);

  return {
    results,
    bm25_hits: bm25.length,
    embedded_used: true,
    cosine_fallback_used: true,
    embedding_model: embedder.model,
    status: 'ok',
    notes: bm25.length === 0 ? [...notes, 'BM25 had 0 hits — cosine-only ranking'] : notes,
  };
}

/**
 * Heuristic: a query is "CJK-heavy" when ≥30% of its non-whitespace characters
 * are CJK (Han + Kana + Hangul). The current SQLite unicode61 tokenizer doesn't
 * split adjacent CJK characters, so BM25 against a CJK-heavy query reliably
 * returns 0 hits. We detect that up-front and skip BM25 to save the work.
 *
 * Mixed queries like "提交 git commit" still go through BM25 because the English
 * portion is enough for the FTS to find candidates the rerank can shape further.
 */
function isCjkHeavyQuery(q: string): boolean {
  const stripped = q.replace(/\s+/g, '');
  if (stripped.length === 0) return false;
  let cjk = 0;
  for (const ch of stripped) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x3040 && code <= 0x30ff) || // Hiragana + Katakana
      (code >= 0x3400 && code <= 0x4dbf) || // CJK Ext A
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified
      (code >= 0xac00 && code <= 0xd7af) || // Hangul
      (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility
      (code >= 0x20000 && code <= 0x2a6df) // CJK Ext B
    ) {
      cjk++;
    }
  }
  return cjk / [...stripped].length >= 0.3;
}
