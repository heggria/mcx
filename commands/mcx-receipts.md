---
allowed-tools: Bash(mcx:*), Bash(command:*), Bash(~/.bun/bin/mcx:*)
description: Show recent mcx audit receipts. Every search/call/index/auth op writes one. Use to diagnose what was called, what failed, and how long things took.
argument-hint: [-n N] [--op search|call|index|auth.login]
---

Read the mcx audit log at `~/.local/state/mcx/audit.jsonl`. Use this to:

- See what tools Claude has been calling and why
- Diagnose a failed run by reading the `error_code` / `error_message`
- Track latency patterns and per-server activity

**Default — last 20 receipts:**

```bash
mcx --json receipts tail -n 20
```

**Filtered by op:**

```bash
mcx --json receipts tail --op call
mcx --json receipts tail --op search -n 50
mcx --json receipts tail --op index
mcx --json receipts tail --op auth.login
```

**What each receipt contains:**

- `call_id`, `correlation_id` (from `MCX_CORRELATION_ID` env if set)
- `op`, `status` (`ok` | `degraded` | `error`), `duration_ms`
- For `search`: `query_hash` + `query_preview` (first ~30 chars only — full plaintext is **never** stored), `results_count`
- For `call`: `server`, `tool`
- For `index`: `results_count` (total tools indexed)
- For `auth.*`: `server`

Audit is local-only (no network egress).
