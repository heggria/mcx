---
name: mcx
description: Use the local `mcx` CLI to discover and call tools across many MCP servers via lazy-loaded semantic search. Replaces the pattern of registering every MCP server in Claude Code (which dumps hundreds of tool schemas into context). When you need to call a tool that's not already loaded — search first, get the schema, then call. Hybrid BM25 + multilingual embedding handles English and CJK queries.
---

# mcx — MCP Tools CLI

Use this skill **whenever you need a tool from one of the MCP servers cataloged in mcx** — instead of asking the user to enable that server natively in Claude Code (which would drop another big tool block into your context), discover and call it through `mcx`.

The CLI is `mcx`. It is a thin wrapper around N MCP backends (stdio / HTTP / SSE) wired into a single discovery surface with audit receipts and OAuth 2.1.

## First Rule

If `mcx` is not on PATH, **stop and run `/mcx-install`** instead of giving up. The CLI installs once via `bun add -g github:heggria/mcx` (or `npm i -g`); the plugin alone cannot ship the binary.

```bash
command -v mcx || echo "missing — run /mcx-install"
```

## When to use mcx

| User intent | Sub-command | Example |
|---|---|---|
| "I need to do X but no obvious MCP tool is loaded" | `mcx search` | `mcx search "create a notion page"` |
| "Call this exact tool with these args" | `mcx call` | `mcx call notion create_page '{"title":"x"}'` |
| "What's in my catalog?" | `mcx list` | `mcx list --server feishu-project` |
| "Refresh the catalog after adding a server" | `mcx index` | `mcx index --embed` |
| "Something failed — what got called?" | `mcx receipts tail` | `mcx receipts tail -n 20` |
| "Server requires auth (OAuth 2.1)" | `mcx auth login` | `mcx auth login notion` |

## Discovery → Call pattern (the canonical flow)

```bash
# 1. Search semantically (top 5 by hybrid BM25 + cosine)
mcx search "在飞书项目里创建工作项" --json

# 2. Get full schema for the chosen tool
mcx search "create work item" -n 1 --full-schema --json

# 3. Call it
mcx call feishu-project create_workitem '{"work_item_type":"story","fields":[...]}' --json
```

**Important:** Run with `--json` whenever you're invoking from a tool/hook so you get a structured envelope instead of pretty-printed output.

## Reading the Output

Every subcommand returns a JSON envelope. Top-level keys:

- `ok` — true/false. Always check this first.
- `op` — which subcommand ran (`search`, `call`, `index`, `auth.login`, etc.)
- `status` — `ok` | `degraded` | `error`. `degraded` means a fallback fired (e.g. embedding rerank skipped because no embeddings exist yet).
- `data` — the actual payload, shape depends on `op`.
- `error.code` + `error.message` — when `ok: false`. Codes you'll see: `auth_missing`, `backend_unknown`, `oauth_discovery_failed`, `token_decrypt_failed`, `config_missing`, `config_invalid`.
- `duration_ms`, `call_id`, `correlation_id`.

For `search` results specifically:
- `data.results[].rank_source` — `'hybrid'` | `'cosine_only'` | `'bm25_only'` (tells you which signal ranked this row).
- `data.bm25_hits` — how many BM25 candidates. If 0 and `cosine_fallback_used: true`, the BM25 missed entirely (common for Chinese queries) and we fell back to pure cosine over the whole catalog.
- `data.embedding_model` — which embedding model is active (`local:Xenova/multilingual-e5-small` by default).

## Common edge cases

- **Tool not in catalog**: re-run `mcx index` first. The catalog only grows when you index.
- **Search returns wrong tool**: try `--rerank-top 50` to widen the BM25 pool, or `--no-embed` to compare pure-BM25 result.
- **Chinese query returns junk**: confirm `data.embedding_model` is the multilingual one. Set `MCX_EMBED_MODEL=multilingual` and `mcx embed --all` to re-embed.
- **OAuth error mid-call**: token might be expired and refresh failed. Run `mcx auth login <server>` again.

## Audit (receipts)

Every call writes one JSON line to `~/.local/state/mcx/audit.jsonl`:

```bash
mcx receipts tail -n 20 --json
mcx receipts tail --op search --json   # filter by op
```

Fields recorded: `call_id`, `op`, `status`, `duration_ms`, `query_hash` + `query_preview` (no full plaintext), `server`, `tool`, `results_count`, `correlation_id` (from `MCX_CORRELATION_ID` env when set).

## Configuration

`~/.config/mcx/backends.toml` declares the MCP backends. Each `[backend.<name>]` section has:
- `type`: `"stdio"` | `"http"` | `"sse"`
- For stdio: `command`, `args`, optional `env`
- For http/sse: `url`, optional `[backend.<name>.auth]` block

Auth modes:
- `kind = "header"` + `name = "X-Foo-Token"` — static header, set with `mcx auth set <server> --token X`
- `kind = "bearer"` — Authorization: Bearer header, set with `mcx auth set <server> --token X`
- `kind = "oauth"` — OAuth 2.1 with discovery + DCR + PKCE, run `mcx auth login <server>`

## When mcx is NOT enough

If the user wants a tool via the original Claude Code MCP integration (e.g. they typed `/mcp` and want native loading), step aside — mcx exists to *replace* that pattern, not to wrap an already-loaded MCP. Don't double-call.

If a backend isn't yet in `backends.toml`, edit the file and re-run `mcx index --server <new>`. Don't call raw HTTP to MCP endpoints — that bypasses the audit + auth layer.

## Troubleshooting

- `config_missing` → run `cp <plugin-path>/examples/backends.toml ~/.config/mcx/backends.toml` and edit.
- `auth_missing` for OAuth → `mcx auth login <server>` (browser will open).
- `token_decrypt_failed` → master key changed. Re-store: `mcx auth set/login <server>`.
- `backend_unknown` → typo in server name. Run `mcx list` to see canonical names.
