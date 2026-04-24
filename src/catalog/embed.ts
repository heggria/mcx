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

const LOCAL_MODELS = {
  multilingual: 'Xenova/multilingual-e5-small',
  english: 'Xenova/all-MiniLM-L6-v2',
} as const;

async function makeLocalEmbedder(): Promise<Embedder> {
  const choice = (process.env.MCX_EMBED_MODEL ?? 'multilingual') as keyof typeof LOCAL_MODELS;
  const modelId = LOCAL_MODELS[choice] ?? LOCAL_MODELS.multilingual;
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
  // Mixing them up significantly hurts cross-lingual retrieval quality.
  const useE5Prefix = modelId.includes('e5');

  return {
    model: `local:${modelId}`,
    dim: 384, // both default models we use are 384-d
    embed: async (texts: string[], inputType: InputType = 'passage'): Promise<Float32Array[]> => {
      const prepared = useE5Prefix
        ? texts.map((t) => `${inputType}: ${t}`)
        : texts;
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

/** Build the text we embed for a tool: name + description + arg names/descriptions. */
export function embeddableText(t: {
  name: string;
  description?: string | null;
  args_text?: string | null;
}): string {
  return [t.name, t.description, t.args_text].filter(Boolean).join('\n').slice(0, 4000);
}
