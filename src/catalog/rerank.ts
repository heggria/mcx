import type { EntityRow } from './store.ts';

/**
 * LLM-based reranker.
 *
 * Hybrid BM25+embedding gives us a top-K candidate list with decent recall (in
 * mcx's internal 200-query benchmark, top-10 recall ≈ 76%) but soft precision
 * (top-1 ≈ 50%). The standard fix is a second-stage LLM rerank: hand the small
 * candidate list to a cheap model that does the actual semantic comparison and
 * reorders.
 *
 * Activated by `--rerank` on `mcx search` (or `opts.rerank: true` on
 * `hybridSearch`). Skipped silently when no API token is configured.
 *
 * Cost: one Haiku call per search, ~200ms, ~0.001¢.
 */

const DEFAULT_BASE = 'https://api.anthropic.com';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

export interface RerankCandidate {
  name: string;
  description: string | null;
  /** Original retrieval score (cosine or bm25) before reranking. */
  score: number;
}

export interface RerankResult {
  /** Candidate names in the reranked order (most relevant first). */
  ranked: string[];
  /** True iff the rerank call succeeded; false on any error (caller falls back). */
  ok: boolean;
  /** Latency of the LLM call in ms. */
  duration_ms: number;
  /** Short error string when ok=false. */
  error?: string;
}

export interface RerankOptions {
  /** Override the model name. Defaults to claude-haiku-4-5-20251001. */
  model?: string;
  /** Per-call timeout in ms. Defaults to 8000. */
  timeoutMs?: number;
}

/**
 * Rerank a candidate list against a query using an LLM.
 *
 * Returns the candidates re-sorted by the LLM. On any failure (no token,
 * network error, malformed JSON, timeout) returns `{ ok: false, ranked: original }`
 * so the caller can transparently fall back to the original ranking.
 */
export async function rerank(
  query: string,
  candidates: RerankCandidate[],
  opts: RerankOptions = {},
): Promise<RerankResult> {
  const start = Date.now();
  const original = candidates.map((c) => c.name);

  if (candidates.length <= 1) {
    return { ok: true, ranked: original, duration_ms: 0 };
  }

  const token = process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY;
  if (!token) {
    return {
      ok: false,
      ranked: original,
      duration_ms: Date.now() - start,
      error: 'no_token',
    };
  }
  const base = process.env.ANTHROPIC_BASE_URL ?? DEFAULT_BASE;
  const model = opts.model ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? 8000;

  // Build a tight prompt. We deliberately ask for top-N name list only (no
  // reasoning) — fast, cheap, easy to parse, and reranking quality is roughly
  // the same with or without chain-of-thought at this candidate count.
  const candidateBlock = candidates
    .map((c, i) => `${i + 1}. ${c.name}\n   ${(c.description ?? '').slice(0, 220)}`)
    .join('\n\n');
  const promptText = [
    `User intent: ${query}`,
    '',
    'Candidate skills (from semantic search):',
    candidateBlock,
    '',
    `Rerank these ${candidates.length} skills by how well they match the user intent.`,
    'Output STRICT JSON only, no preamble, no markdown fence:',
    '{"ranked": ["<best>", "<2nd>", "<3rd>", ...]}',
    '',
    'Rules:',
    `- "ranked" must contain ALL ${candidates.length} candidate names, no duplicates, no additions`,
    '- Best match first, worst last',
    '- Use the exact name strings as written (case-sensitive, no extra whitespace)',
  ].join('\n');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': token,
      'anthropic-version': '2023-06-01',
    };
    if (process.env.ANTHROPIC_CUSTOM_HEADERS) {
      // Format: "Header1: val1, Header2: val2" — same as Claude Code's reading.
      const pairs = process.env.ANTHROPIC_CUSTOM_HEADERS.split(',');
      for (const pair of pairs) {
        const colon = pair.indexOf(':');
        if (colon > 0) {
          const k = pair.slice(0, colon).trim();
          const v = pair.slice(colon + 1).trim();
          if (k && v) headers[k] = v;
        }
      }
    }
    const resp = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        max_tokens: 200,
        messages: [{ role: 'user', content: promptText }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!resp.ok) {
      const errText = await resp.text();
      return {
        ok: false,
        ranked: original,
        duration_ms: Date.now() - start,
        error: `http_${resp.status}: ${errText.slice(0, 120)}`,
      };
    }
    const data = (await resp.json()) as {
      content?: Array<{ type: string; text: string }>;
    };
    const text = data.content?.[0]?.text ?? '';
    const stripped = stripJsonFence(text);
    let parsed: { ranked?: unknown };
    try {
      parsed = JSON.parse(stripped) as { ranked?: unknown };
    } catch {
      return {
        ok: false,
        ranked: original,
        duration_ms: Date.now() - start,
        error: 'parse: ' + stripped.slice(0, 120),
      };
    }
    if (!parsed.ranked || !Array.isArray(parsed.ranked)) {
      return {
        ok: false,
        ranked: original,
        duration_ms: Date.now() - start,
        error: 'bad_shape',
      };
    }
    // Validate every reranked name exists in the original candidate set.
    const candidateSet = new Set(original);
    const validRanked = parsed.ranked
      .filter((x): x is string => typeof x === 'string')
      .filter((x) => candidateSet.has(x));

    // If the LLM produced fewer valid names than candidates, append the
    // remaining originals in their original order so we don't lose any.
    const merged = [...validRanked];
    for (const name of original) {
      if (!merged.includes(name)) merged.push(name);
    }

    return { ok: true, ranked: merged, duration_ms: Date.now() - start };
  } catch (e) {
    clearTimeout(timeoutId);
    const msg = (e as Error).name === 'AbortError' ? 'timeout' : ((e as Error).message ?? String(e));
    return {
      ok: false,
      ranked: original,
      duration_ms: Date.now() - start,
      error: msg,
    };
  }
}

function stripJsonFence(text: string): string {
  const m = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  return (m && m[1] ? m[1] : text).trim();
}

/** Build a RerankCandidate list from EntityRow[] preserving original score. */
export function entitiesToCandidates(
  entities: Array<{ entity: EntityRow; score: number }>,
): RerankCandidate[] {
  return entities.map((e) => ({
    name: e.entity.name,
    description: e.entity.description,
    score: e.score,
  }));
}
