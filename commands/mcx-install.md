---
allowed-tools: Bash(command:*), Bash(npm:*), Bash(bun:*), Bash(node:*), Bash(which:*), Bash(echo:*), Bash(curl:*), Bash(mkdir:*), Bash(cp:*), Bash(test:*)
description: Install or upgrade the mcx CLI. Run this when /mcx, /mcx-search, /mcx-call etc. report "mcx not installed".
---

The mcx plugin contains slash commands and a routing skill, but **does not ship the CLI binary**. The `mcx` CLI is distributed via npm / bun.

Pick one install path — they all give a global `mcx` command.

## Path 1 — bun (recommended; mcx is built for Bun runtime)

```bash
bun add -g github:heggria/mcx
mcx --version
```

Or run without installing:

```bash
bunx github:heggria/mcx --version
```

## Path 2 — npm / node

```bash
npm i -g github:heggria/mcx
mcx --version
```

## Path 3 — local clone + bun link (for development)

```bash
git clone https://github.com/heggria/mcx ~/code/mcx
cd ~/code/mcx
bun install
bun run build
bun link              # exposes `mcx` on PATH
```

## Then initialize config

```bash
mkdir -p ~/.config/mcx
cp ~/code/mcx/examples/backends.toml ~/.config/mcx/backends.toml   # or wherever your install lives
# Edit backends.toml to declare your MCP servers
```

## Optional: tell mcx which embedding model to use

```bash
# Multilingual (default; supports Chinese/CJK; ~118MB model downloaded on first embed)
export MCX_EMBED_MODEL=multilingual

# English-only, faster, smaller (~25MB)
export MCX_EMBED_MODEL=english

# Or use an API provider if you have a key (overrides local):
export VOYAGE_API_KEY=pa-xxx        # voyage-3-lite, multilingual, fastest
export OPENAI_API_KEY=sk-xxx        # text-embedding-3-small
```

## First-time setup

```bash
# 1. Inject any static-token backends
mcx auth set lark-mcp --token mat_xxx
mcx auth set feishu-project --token m-xxx

# 2. Run OAuth for backends that need it
mcx auth login notion   # opens browser

# 3. Index everything + generate embeddings
mcx index --embed       # first run downloads the embedding model

# 4. Verify
mcx list
mcx search "your first query"
```

After install, retry whichever slash command brought you here.

## Troubleshooting install

- `EACCES` on bun add -g → ensure `~/.bun/bin` is on PATH and writable
- `Cannot find module ../bin/.../onnxruntime_binding.node` → `bun pm trust --all` in the install dir
- `command not found: mcx` after install → `which bun && ls ~/.bun/bin/mcx` to confirm symlink exists
