---
allowed-tools: Bash(mcx:*), Bash(command:*), Bash(~/.bun/bin/mcx:*)
description: Top-level mcx entry point. Auto-detects whether you want search / call / index / list / receipts based on phrasing, and invokes the right subcommand.
argument-hint: <natural language: "find / call / list / index / what happened">
---

This is the main mcx entry point. Use it when the user's intent is broadly "do something via mcx" but you're not sure which subcommand fits — this command picks one based on the phrasing of $ARGUMENTS.

**Precondition:** verify `mcx` is on PATH. If not, run `/mcx-install` and stop.

```bash
command -v mcx >/dev/null 2>&1 || { echo "mcx not installed; run /mcx-install"; exit 64; }
```

## Decision rules (read $ARGUMENTS, pick one)

1. Looks like a question/intent ("how do I...", "find tool that...", "create...", "搜索...") → **search**
   ```bash
   mcx --json search "$ARGUMENTS"
   ```

2. Starts with `<server> <tool>` and contains `{...}` → **call**
   ```bash
   mcx --json call $ARGUMENTS
   ```

3. Words like "list", "show", "inventory", "what's available", "什么工具" → **list**
   ```bash
   mcx --json list
   ```

4. "refresh", "rebuild", "re-index", "更新目录" → **index**
   ```bash
   mcx --json index --embed
   ```

5. "what happened", "audit", "history", "logs", "recent calls" → **receipts**
   ```bash
   mcx --json receipts tail -n 20
   ```

6. Anything mentioning auth/login/token → **auth subcommands**
   - "login" / "OAuth" → `mcx --json auth login <server>`
   - "set token" → `mcx --json auth set <server> --token <X>`
   - "list tokens" → `mcx --json auth list`

When ambiguous, default to **search** — the cheapest discovery action. Then use `/mcx-call` to follow up if the user wants to actually invoke a tool.

## Reading the result

The first thing to check is `ok`. If false, surface `error.message` to the user and stop. If true, summarize `data.results` (search) / `data.content` (call) / `data.servers` (list) / `data.records` (receipts) compactly — don't dump the full JSON unless the user asked.

If you want fine-grained control, use the dedicated commands:
- `/mcx-search <query>`
- `/mcx-call <server> <tool> '<args>'`
- `/mcx-list [--server X]`
- `/mcx-auth [set|login|list|rm] <server>`
- `/mcx-receipts [-n N] [--op X]`
