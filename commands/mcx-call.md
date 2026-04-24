---
allowed-tools: Bash(mcx:*), Bash(command:*), Bash(~/.bun/bin/mcx:*)
description: Invoke a specific tool on a cataloged backend through the mcx CLI. Args are JSON. Returns content + structuredContent. Use after /mcx-search to identify the right server.tool pair.
argument-hint: <server> <tool> '<json args>'
---

Use the `mcx` CLI to invoke a tool on a backend MCP server. The CLI handles connection, auth (OAuth refresh if needed), timeouts, and audit logging.

**Precondition:** verify `mcx` is on PATH. If not, run `/mcx-install` and stop.

**Standard invocation:**

```bash
mcx --json call <server> <tool> '<json args>'
```

`<json args>` must be a JSON object (use `'{}'` for no args). Parse $ARGUMENTS as `<server> <tool> <json>`.

**Examples:**

```bash
mcx --json call feishu-project list_todo '{"action":"todo","page_num":1}'
mcx --json call notion search '{"query":"meeting notes","query_type":"internal","filters":{}}'
mcx --json call chrome-devtools take_screenshot '{"format":"png"}'
```

**With longer timeout (e.g. browser cold start, slow LLM-backed servers):**

```bash
mcx --json call <server> <tool> '<args>' --timeout 120000
```

## Reading the response

```json
{
  "ok": true,
  "data": {
    "server": "...",
    "tool": "...",
    "cataloged": true,
    "isError": false,
    "content": [{"type": "text", "text": "..."}],
    "structuredContent": {...}
  }
}
```

- `ok: true` + `data.isError: false` → tool ran successfully
- `ok: true` + `data.isError: true` → tool itself returned an error result (read `content[*].text`)
- `ok: false` → CLI/connection-level failure (read `error.message`); likely needs config or auth fix
- `cataloged: false` → you called a tool that's not in the catalog (will still work if the server has it; consider `mcx index` to refresh)

## Common errors

- `auth_missing` → run `mcx auth set <server> --token X` (header/bearer) or `mcx auth login <server>` (oauth)
- `backend_unknown` → typo in server name; check `mcx list`
- `invalid_args` → JSON parse failed; verify quoting, especially in shells
- timeout → re-run with `--timeout 120000`; some servers (Chrome cold start) take 10-30s the first call

## After calling

If the call succeeded but the result was unexpected, examine the `structuredContent` (when present) — it's the machine-readable form. The `content[]` array is what humans see.

Always check `mcx receipts tail` after a session to audit which tools fired.
