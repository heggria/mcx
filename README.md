# mcx — MCP Tools CLI

A unified CLI + Claude Code plugin for searching, calling, and governing tools across many MCP servers.
Designed in the spirit of [`wsc`](https://github.com/heggria/web-surfing-cli) — but for MCP instead of the web.

## Why

Every MCP server you add to Claude Code dumps its full tool schemas into the model's context window upfront.
Five servers with 10–40 tools each easily eats ~20k context tokens before the model does any actual work,
and Anthropic's own data shows tool selection accuracy degrades sharply past 30–50 tools loaded at once.

`mcx` puts every backend behind a single CLI:

- `mcx search "<intent>"` — hybrid BM25 + multilingual embedding rerank across every cataloged tool
- `mcx call <server> <tool> '<json>'` — execute, with audit + auth + timeout
- `mcx auth set/login/list/rm` — encrypted token storage, including OAuth 2.1 flows
- `mcx receipts tail` — JSONL audit log of every call

The model loads `mcx` as one tool surface instead of all backends. It searches when it needs something.

## Install (development)

```bash
git clone https://github.com/heggria/mcx ~/code/mcx && cd ~/code/mcx
bun install
bun pm trust --all          # for sharp / protobufjs natives used by transformers.js
bun run build
bun link                    # exposes `mcx` on PATH

mkdir -p ~/.config/mcx
cp examples/backends.toml ~/.config/mcx/backends.toml
# Edit it to point at your MCP servers
```

## Quickstart

```bash
# Static-token backends
mcx auth set lark-mcp --token mat_xxx
mcx auth set feishu-project --token m-xxx

# OAuth 2.1 backends (browser opens, PKCE + DCR happen automatically)
mcx auth login notion

# Build the catalog and generate embeddings (first run downloads ~118MB model)
mcx index --embed

# Hybrid search (English + 中文 both work via multilingual e5-small)
mcx search "在飞书里创建一个工作项"
mcx search "screenshot the current browser page"

# Get full schema for the top match, then invoke
mcx search "list my todos" -n 1 --full-schema
mcx call feishu-project list_todo '{"action":"todo","page_num":1}'

# Audit
mcx receipts tail -n 20
```

## Claude Code plugin

The repo doubles as a Claude Code plugin. Install path:

```
~/.claude/plugins/cache/mcx/mcx/0.1.0/   →   <this-repo>
```

Once symlinked + registered (see `installed_plugins.json` + `enabledPlugins`), Claude Code exposes:

- `/mcx` — auto-routing entry point
- `/mcx-search`, `/mcx-call`, `/mcx-list`, `/mcx-auth`, `/mcx-receipts`, `/mcx-install` — direct slash commands
- The `mcx` skill — Claude reads this to decide when to use mcx instead of native MCP

## Architecture

```
backends.toml          → config of N MCP servers (stdio/HTTP/SSE)
       ↓
mcx CLI subcommands    → discover/index/search/call/auth/receipts
       ↓
catalog.db (SQLite)    → tools, tools_fts (BM25), tool_embeddings (cosine), oauth_clients
       ↓
@xenova/transformers   → multilingual-e5-small (default), or Voyage/OpenAI when env keys set
       ↓
@modelcontextprotocol/sdk + custom OAuth 2.1 (PKCE + DCR)
       ↓
audit.jsonl (~/.local/state/mcx/)
```

## Status

- **Phase 1** ✓ BM25 search, stdio/HTTP/SSE backends, encrypted Bearer/header tokens, audit
- **Phase 2** ✓ Multilingual embedding rerank (local transformers.js), OAuth 2.1 with PKCE+DCR + auto-refresh
- **Plugin** ✓ Slash commands + routing skill registered with Claude Code
- **Phase 3** (future) keytar system keychain, single-binary `bun build --compile`, embedding provider hot-swap

