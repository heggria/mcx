---
allowed-tools: Bash(mcx:*), Bash(command:*), Bash(~/.bun/bin/mcx:*)
description: Top-level mcx entry point. Auto-detects whether you want search / call / skill show / index / list / receipts based on phrasing, and invokes the right subcommand.
argument-hint: <natural language: "find / call / load skill / list / index / what happened">
---

This is the main mcx entry point. mcx catalogs both **MCP tools** AND **Claude skills**, so a single search covers both.

**Precondition:** verify `mcx` is on PATH. If not, run `/mcx-install` and stop.

```bash
command -v mcx >/dev/null 2>&1 || { echo "mcx not installed; run /mcx-install"; exit 64; }
```

## Decision rules (read $ARGUMENTS, pick one)

1. Looks like a question/intent ("how do I...", "find...", "create...", "搜索...", "有没有...") → **search**
   ```bash
   mcx --json search "$ARGUMENTS"
   ```

2. Phrasing like "load skill X" / "use skill X" / "show me <name> skill" → **skill show**
   ```bash
   mcx --json skill show <name>
   ```

3. Starts with `<server> <tool>` and contains `{...}` → **call**
   ```bash
   mcx --json call $ARGUMENTS
   ```

4. Words like "list", "show", "inventory", "what's available", "什么工具", "哪些 skill" → **list**
   ```bash
   mcx --json list
   ```

5. "refresh", "rebuild", "re-index", "更新目录", "扫描技能" → **index**
   ```bash
   mcx --json index --all --embed
   ```

6. "what happened", "audit", "history", "logs", "recent calls" → **receipts**
   ```bash
   mcx --json receipts tail -n 20
   ```

7. Anything mentioning auth/login/token → **auth subcommands**
   - "login" / "OAuth" → `mcx --json auth login <server>`
   - "set token" → `mcx --json auth set <server> --token <X>`
   - "list tokens" → `mcx --json auth list`

When ambiguous, default to **search** — it's the cheapest discovery action. Then use `/mcx-skill <name>` or `/mcx-call <server> <tool>` to follow up depending on whether the top hit is a skill or a tool.

## Reading the result

Check `ok` first. If false, surface `error.message` and stop. If true, summarize the relevant payload compactly — don't dump full JSON unless asked.

- `search` → `data.results` (look at `kind` to know if each row is skill or tool)
- `skill show` → `data.body` is the full SKILL.md, follow it
- `call` → `data.content` / `data.structuredContent`
- `list` → `data.servers` / `data.skill_roots` / `data.entities`
- `receipts` → `data.records`

## Fine-grained commands

- `/mcx-search <query> [--kind skill|tool]`
- `/mcx-skill <name>` (load skill body) or `/mcx-skill --search <intent>`
- `/mcx-call <server> <tool> '<args>'`
- `/mcx-list [--server X | --kind skill]`
- `/mcx-auth [set|login|list|rm] <server>`
- `/mcx-receipts [-n N] [--op X]`
