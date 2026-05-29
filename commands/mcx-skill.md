---
allowed-tools: Bash(mcx:*), Bash(command:*), Bash(~/.bun/bin/mcx:*)
description: Show a cataloged skill's full body (or search for one when --search given). Use to load a skill into the conversation after mcx search surfaces it.
argument-hint: <skill-name> | --search <intent>
---

Load a skill body into the current conversation via mcx.

**Precondition:** verify `mcx` is on PATH.

```bash
command -v mcx >/dev/null 2>&1 || { echo "mcx not installed; run /mcx-install"; exit 64; }
```

## Routes

1. Bare name → `mcx skill show <name>`:

```bash
mcx --json skill show $ARGUMENTS
```

2. `--search <intent>` → run a search restricted to skills, then call `skill show` on the top hit:

```bash
mcx --json search "$ARGUMENTS" --kind skill -n 5
# Then pick the best hit by score + read its body:
mcx --json skill show <top-name>
```

3. `--meta-only` to skip reading the SKILL.md body (cheap existence check):

```bash
mcx --json skill show $ARGUMENTS --meta-only
```

## Reading the result

`skill show` returns:
- `name` — skill slug
- `source` — which root (e.g. `skill-root:1`)
- `description` — frontmatter description
- `triggers` — extracted trigger phrases
- `body_path` — absolute path to SKILL.md
- `body_size` — bytes
- `body` — full SKILL.md text (unless `--meta-only`)

**Use the `body` field as if Claude Code had natively invoked this skill** — its rules / sub-commands / constraints apply for the rest of this session.

## When to use

- `mcx search --kind skill ...` returned a promising hit and you want to load it → `mcx skill show <hit>`
- You know the skill name but it's not in your active `available-skills` list → load it via this command
- You want to inspect a skill's instructions without re-reading the file from disk yourself

## Common mistakes

- Calling `mcx skill show` on something that isn't in the skill catalog → `error.code = skill_unknown`. Run `mcx index --skills` to refresh.
- Treating the returned `body` as advisory text instead of binding instructions — it IS the skill, follow it.
