import { cacheDir, ensureDirs } from '../util/paths.ts';

/**
 * Embedding adapter.
 *
 * Provider precedence (env-driven):
 *   1. VOYAGE_API_KEY      → voyage-3-lite (paid, fast, multilingual, best)
 *   2. OPENAI_API_KEY      → text-embedding-3-small (paid, fast, multilingual)
 *   3. else                → @xenova/transformers locally (free, ships model on first use)
 *
 * Local model selection (env: MCX_EMBED_MODEL):
 *   - 'multilingual' (default) → Xenova/multilingual-e5-small (~118MB, supports CJK)
 *   - 'english'                → Xenova/all-MiniLM-L6-v2     (~25MB, English-only, faster)
 *
 * All providers normalize to L2-unit vectors so cosine reduces to dot product.
 */

export type InputType = 'query' | 'passage';

export interface Embedder {
  readonly model: string;
  readonly dim: number;
  embed(texts: string[], inputType?: InputType): Promise<Float32Array[]>;
}

let cached: Embedder | null = null;

export async function getEmbedder(): Promise<Embedder> {
  if (cached) return cached;
  if (process.env.VOYAGE_API_KEY) {
    cached = await makeVoyageEmbedder(process.env.VOYAGE_API_KEY);
  } else if (process.env.OPENAI_API_KEY) {
    cached = await makeOpenAIEmbedder(process.env.OPENAI_API_KEY);
  } else {
    cached = await makeLocalEmbedder();
  }
  return cached;
}

/* ───────────────── Local (transformers.js) ───────────────── */

/**
 * Local embedding model registry. Pick via env `MCX_EMBED_MODEL=<key>`.
 *
 * Default: `multilingual` (e5-small, 118MB, 384-d).
 *
 * Model selection notes (informed by mcx-internal benchmarks on a CN-EN mixed
 * skill catalog of ~200 entries):
 *
 *   - e5-small (default): 7/9 top-1 hit rate on Chinese queries against a CN-EN
 *     mixed catalog. The multilingual training shines when queries are CN but
 *     skill names are EN, because cross-lingual alignment is its specialty.
 *
 *   - e5-base: same family, 768-d, ~279MB. Marginal upgrade over small. Worth it
 *     when catalog grows past ~1k entries.
 *
 *   - bge-m3: 1024-d, ~570MB. SOTA on MTEB but in our internal test it underperforms
 *     e5 on CN-EN mixed retrieval — its "Chinese specialization" hurts cross-lingual
 *     alignment. Recommended only if catalog is overwhelmingly Chinese.
 *
 *   - english (all-MiniLM-L6-v2): 25MB, 384-d, EN-only.
 */
const LOCAL_MODELS = {
  multilingual: { id: 'Xenova/multilingual-e5-small', dim: 384 },
  'e5-base':    { id: 'Xenova/multilingual-e5-base', dim: 768 },
  'bge-m3':     { id: 'Xenova/bge-m3', dim: 1024 },
  english:      { id: 'Xenova/all-MiniLM-L6-v2', dim: 384 },
} as const;

async function makeLocalEmbedder(): Promise<Embedder> {
  const choice = (process.env.MCX_EMBED_MODEL ?? 'multilingual') as keyof typeof LOCAL_MODELS;
  const spec = LOCAL_MODELS[choice] ?? LOCAL_MODELS.multilingual;
  const modelId = spec.id;
  const dim = spec.dim;
  ensureDirs();

  // Tell transformers.js where to cache. Defaults to ./.cache; we redirect to XDG cache.
  const tx = await import('@xenova/transformers');
  // biome-ignore lint/suspicious/noExplicitAny: transformers.js .env shape is loose
  (tx as unknown as { env: any }).env.cacheDir = `${cacheDir}/models`;
  // biome-ignore lint/suspicious/noExplicitAny: same
  (tx as unknown as { env: any }).env.allowLocalModels = false;
  // biome-ignore lint/suspicious/noExplicitAny: same
  (tx as unknown as { env: any }).env.allowRemoteModels = true;

  const pipeline = await tx.pipeline('feature-extraction', modelId);
  // E5 family expects "query: " for queries and "passage: " for documents.
  // BGE family doesn't use query prefixes (or uses different ones).
  // Mixing them up significantly hurts cross-lingual retrieval quality.
  const useE5Prefix = modelId.includes('e5');

  return {
    model: `local:${modelId}`,
    dim,
    embed: async (texts: string[], inputType: InputType = 'passage'): Promise<Float32Array[]> => {
      const prepared = useE5Prefix ? texts.map((t) => `${inputType}: ${t}`) : texts;
      // Process one at a time to keep memory bounded; transformers.js batches internally.
      const out: Float32Array[] = [];
      for (const t of prepared) {
        const r = await pipeline(t, { pooling: 'mean', normalize: true });
        // r.data is a TypedArray (Float32Array for normalized embeddings).
        out.push(new Float32Array(r.data as ArrayLike<number>));
      }
      return out;
    },
  };
}

/* ───────────────── Voyage (paid, future-ready) ───────────────── */

async function makeVoyageEmbedder(apiKey: string): Promise<Embedder> {
  const model = process.env.VOYAGE_MODEL ?? 'voyage-3-lite';
  return {
    model: `voyage:${model}`,
    dim: 512, // voyage-3-lite default
    embed: async (texts: string[], inputType: InputType = 'passage'): Promise<Float32Array[]> => {
      const r = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          input: texts,
          model,
          input_type: inputType === 'query' ? 'query' : 'document',
        }),
      });
      if (!r.ok) throw new Error(`voyage embed failed: ${r.status} ${await r.text()}`);
      const j = (await r.json()) as { data: Array<{ embedding: number[] }> };
      return j.data.map((d) => normalizeUnit(new Float32Array(d.embedding)));
    },
  };
}

/* ───────────────── OpenAI (paid, ubiquitous) ───────────────── */

async function makeOpenAIEmbedder(apiKey: string): Promise<Embedder> {
  const model = process.env.OPENAI_EMBED_MODEL ?? 'text-embedding-3-small';
  return {
    model: `openai:${model}`,
    dim: 1536,
    embed: async (texts: string[], _inputType: InputType = 'passage'): Promise<Float32Array[]> => {
      // OpenAI doesn't differentiate query vs passage at the API layer.
      const r = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ input: texts, model }),
      });
      if (!r.ok) throw new Error(`openai embed failed: ${r.status} ${await r.text()}`);
      const j = (await r.json()) as { data: Array<{ embedding: number[] }> };
      return j.data.map((d) => normalizeUnit(new Float32Array(d.embedding)));
    },
  };
}

/* ───────────────── Vector helpers ───────────────── */

function normalizeUnit(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i] ?? 0;
    s += x * x;
  }
  const n = Math.sqrt(s);
  if (n === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = (v[i] ?? 0) / n;
  return out;
}

/** Cosine similarity assuming both inputs are unit vectors (i.e. dot product). */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

/** Build the text we embed for an entity (tool or skill). */
export function embeddableText(t: {
  name: string;
  description?: string | null;
  args_text?: string | null;
  triggers?: string | null;
}): string {
  return [t.name, t.description, t.args_text, t.triggers].filter(Boolean).join('\n').slice(0, 4000);
}
