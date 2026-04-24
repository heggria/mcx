---
allowed-tools: Bash(mcx:*), Bash(command:*), Bash(~/.bun/bin/mcx:*)
description: Discover the right MCP tool for an intent across all cataloged backends. Hybrid BM25 + multilingual embedding rerank. Returns top-N candidates with description, args, and source-of-rank metadata.
argument-hint: <natural language query>
---

Use the `mcx` CLI to find the most relevant MCP tools for a user intent, **without** loading every backend's full schema into context.

**Precondition:** verify `mcx` is on PATH. If not, run `/mcx-install` and stop.

```bash
command -v mcx >/dev/null 2>&1 || { echo "mcx not installed; run /mcx-install"; exit 64; }
```

**Default search:**

```bash
mcx --json search "$ARGUMENTS"
```

**Wider candidate pool (helps for vague queries):**

```bash
mcx --json search "$ARGUMENTS" --rerank-top 50
```

**Restrict to one backend:**

```bash
mcx --json search "$ARGUMENTS" --server feishu-project
```

**Get full input schema for the top match (so you can construct args next):**

```bash
mcx --json search "$ARGUMENTS" -n 1 --full-schema
```

**Compare with pure BM25 (skip embedding rerank):**

```bash
mcx --json search "$ARGUMENTS" --no-embed
```

## Reading results

Each result row contains:
- `server` + `name` — backend + tool identifier (use these in `mcx call`)
- `score` — final ranking score (cosine when reranked, BM25 otherwise)
- `bm25_score` — original BM25 score (negative; lower = better) or `null`
- `cosine` — embedding similarity (0–1) or `null`
- `rank_source` — `'hybrid'` | `'cosine_only'` | `'bm25_only'`
- `args` — list of input field names (when `--full-schema` not used)
- `required` — required fields
- `description` — human-readable description

Top-level metadata:
- `bm25_hits` — how many BM25 candidates entered rerank
- `cosine_fallback_used` — true when BM25 returned 0 (common for non-English queries)
- `embedding_model` — active model (e.g. `local:Xenova/multilingual-e5-small`)

## When the result looks wrong

1. **Too few hits** — try `--rerank-top 50` or rephrase with more keywords
2. **Wrong language** — confirm `embedding_model` is the multilingual one
3. **Stale catalog** — run `mcx index --embed` to refresh
4. **No embeddings** — output will say `status: 'degraded'`; run `mcx embed`

After finding the right tool, use `/mcx-call` (or call directly with `mcx call`) to execute it.
