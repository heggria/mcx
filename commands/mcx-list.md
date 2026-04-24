---
allowed-tools: Bash(mcx:*), Bash(command:*), Bash(~/.bun/bin/mcx:*)
description: List all cataloged servers and tools. Useful for inventory, sanity-checking the catalog, or finding canonical server/tool names before /mcx-call.
argument-hint: [--server NAME]
---

Show what's in the mcx catalog (servers + tools).

**Full inventory:**

```bash
mcx --json list
```

**Tools for one backend:**

```bash
mcx --json list --server $ARGUMENTS
```

**Tools only (skip the per-server summary):**

```bash
mcx --json list --tools-only
```

## Output shape

```json
{
  "data": {
    "servers": [
      { "name": "feishu-project", "transport": "http", "tool_count": 42, "indexed_at": 1714..., "last_error": null }
    ],
    "tools": [
      { "server": "feishu-project", "name": "create_workitem", "description": "..." }
    ]
  }
}
```

- `last_error` non-null → that backend failed during the last `mcx index` (auth, network, etc.). Run `mcx index --server <name>` to retry.
- `tool_count: 0` → backend exists in config but no tools indexed. Common causes: auth missing, server unreachable, or never `mcx index`-ed yet.

If the catalog is empty or stale, run `mcx index --embed` first.
