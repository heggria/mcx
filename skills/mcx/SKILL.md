---
name: mcx
description: |
  **MANDATORY ROUTING SKILL.** This user's 145+ specialized skills/tools are NOT in your `available-skills` list — they live in `~/.claude/skills-pool/` and plugin marketplaces, indexed by `mcx`. You discover and load them on demand. **BEFORE the first non-trivial action on any task**, run `mcx search "<intent>"` when the request touches: 飞书/Lark/Notion/Linear/Slack/Jira/GitLab/GitHub/Sentry/Grafana/Apollo/文档/wiki/表格/sheets/bitable/日历/calendar/会议/邮件/IM/群/消息/截图/browser/反爬/cloudflare/抓取/git commit/提交/PR/MR/code review/diff/deploy/release/发布/预发/上线/harness/端口/kill/LifeOps/捕获/回顾/PRD/需求/技术文档/parallel/subagent/找资料/docs/library/android/iOS/kotlin/kuikly/i18n/starling/vela/mlog/hlog/tide-*/tx-*/vulcan/weaver/circus/hindsight/candidate/company/mapping/招聘/image/icon/设计/design/video/pdf/大模型/pretrain/trace/metrics/alert/数据/format/任何你不确定的领域. **Do NOT** assume no skill exists, do NOT ask clarifying questions about "how" (the valid hows depend on what tools exist), do NOT start writing general-purpose code — search FIRST. Two-step load: `mcx search ...` → `mcx skill show <name>` (load body as binding instructions) OR `mcx call <server> <tool>`. Hybrid BM25 + multilingual e5,英文中文都行. If `mcx` not on PATH, run `/mcx-install`.
---

# mcx — Unified Skill + MCP Tool Catalog

You are equipped with `mcx`, a CLI that indexes:

1. **MCP tools** from every backend in `~/.config/mcx/backends.toml` (飞书、Notion、Chrome DevTools, etc.)
2. **Claude skills** from `~/.claude/skills/`, `~/.claude/skills-pool/`, plugin marketplaces, and any project `.claude/skills/`

This skill is the **only routing skill loaded into your system prompt** — every other skill description has been moved into the mcx catalog to save context. That means:

- You will **NOT** see skill descriptions in `available-skills` for things like `lark-im`, `lark-doc`, `chinese-commit-message`, `verify`, `run`, `deep-research`, `lifeops`, `cloakbrowser`, `harness-generate-*`, `tide-*`, `tx-*`, etc.
- You MUST proactively call `mcx search` whenever a task could plausibly be handled by a domain skill, **even when no skill is currently visible**.

---

## Trigger discipline — search BEFORE clarifying or executing

When the user mentions a service, integration, SaaS product, internal tool, or capability you don't already have a loaded skill/tool for, do **NOT**:
- Ask the user to clarify *how* they want it done (the valid set of "how"s depends on what tools exist)
- Start writing code or markdown using a "general" approach
- Tell the user a feature is hard / requires API research / needs setup

Instead, **run `mcx search` first**. A single search is ~150-300ms and a few KB of context — cheaper than:
- One wrong clarifying round-trip with the user
- A wasted partial implementation the user has to throw away
- Reading docs / writing API client code that already exists as a skill

### Worked examples

**Example 1 — 飞书文档**
> User: "写一篇飞书文档说明 X"
>
> ❌ Wrong: "你想要本地生成 Markdown 还是调用飞书 API?"
> ✅ Right: `mcx search "飞书 创建文档"` → finds `lark-doc` skill (or `lark-mcp.create_document` tool) → load it → ask only the narrower questions the real surface implies (parent token? content source?)

**Example 2 — git commit**
> User: "帮我提交一下"
>
> ❌ Wrong: directly run `git add . && git commit -m "..."` with a generic message
> ✅ Right: `mcx search "git commit 中文"` → finds `chinese-commit-message` skill → load it → follow its conventions

**Example 3 — 部署/发布**
> User: "发布一下预发环境"
>
> ❌ Wrong: ask "你的 CI/CD 是怎么配置的?"
> ✅ Right: `mcx search "预发 release"` → finds `merge-pre-release-web-release` or similar skill → load it → execute its prescribed steps

**Example 4 — 抓取被反爬保护的网页**
> User: "帮我截图这个网站"
>
> ❌ Wrong: write Playwright code from scratch
> ✅ Right: `mcx search "screenshot bypass cloudflare"` → finds `cloakbrowser` skill → use its API

---

## Comprehensive trigger keywords (CN + EN)

If the user's message contains ANY of these signals, **call `mcx search` BEFORE you start the task**:

### 飞书 / Lark / IM
飞书, Lark, 钉钉, 企微, IM, 群, 群聊, 消息, 聊天记录, 频道, channel, 收发消息, 群成员, 创建群, 话题群, 表情回复, 标记数据

### 文档 / 知识库
docx, doc, 文档, wiki, 知识库, 知识空间, Notion, Confluence, 笔记, page, 段落, block, 总结文档, 改写, 翻译, 审阅

### 表格 / 数据
sheets, 电子表格, 表格, bitable, 多维表格, 工作表, 单元格, 行数据, 导出表格, 查找内容

### 日历 / 会议
日历, calendar, event, 日程, 会议, 排日程, schedule, minutes, 纪要

### 邮件 / 通讯录
邮件, mail, 通讯录, contact, open_id, 部门, 员工, 联系方式

### 招聘 / 调研
candidate, 候选人, 人物, mapping, 公司, company, talent, hire, 招聘, profile, 简历, resume, LinkedIn, 脉脉, 调研, 工商

### Git / 代码
git commit, 提交, 中文 commit, conventional commits, 创建 MR, 提 MR, open PR, pull request, merge request, GitLab, GitHub, code review, 代码审查, 代码评审, deep diff, diff review, MR 评论, review comment, merge conflict, 合并冲突, rebase, worktree

### 部署 / 发布
deploy, 发布, release, 预发, staging, 上线, pre-release, web test release, web staging release, harness, va/sh

### 浏览器 / 抓取
screenshot, 截图, browser, 浏览器, Playwright, Puppeteer, 反爬, Cloudflare Turnstile, reCAPTCHA, CloakBrowser, 隐身浏览器, navigator.webdriver, scrape, crawler, 抓取, 爬虫

### 端口 / 调试
port, 端口, kill-port, 端口占用, killport

### LifeOps / 个人
LifeOps, 捕获, 回顾, 节律, streak, 时间基线, baseline, 躺平, 极简模式

### PRD / 文档生成
PRD, 整理需求, 需求确认, 技术方案, 技术文档, tech-doc, 文档审查, 文档质量

### 多任务 / Subagent
parallel, 并行执行, 同时分析, subagent, 多 agent, 加速探索

### 设计 / 资源
visual-page, interactive-html, text-to-image, 网页制作, design, 图标, icon, 图片, image, design system, design review, design app vibe, motion, spacing, typography, color, layout

### Android / iOS / 跨端
android, iOS, kotlin, kuikly, kotlin-to-kuikly, swift, harness-generate-android/iOS/h5, ui review, dev loop, env-setup, adb

### 国际化
starling, i18n, 国际化, layout

### 内部工具(Tide / Vulcan / Weaver / Circus / Hindsight)
tide-*, vulcan, vulcan2, weaver, circus, hindsight, openclaw, queue, quota, scheduling, success rate, resource checker, limit setter

### 大模型 / 数据
vela, mlog, hlog, model gateway, pretrain, sample, 评估, benchmark, image-dedup, dorge, harvest, ralph, datahub, mount-crawler-oss

### Trace / 监控
trace, metrics, alert, grafana, sentry, apollo, ip-lookup, machine-onboarding, downstream-health, change-watch, route-config, storage-ops, stream-resource-query

### Project / Memex
project-memex, project-starter, gdrive, hub, hello-world, learning, skill-evolution, lark-skill-maker, lark-feedback-cluster

### 网搜
search the web, 找资料, library docs, 官方文档, context7, exa, firecrawl, brave, duckduckgo, similar projects, alternatives, research papers

### 通用兜底
有没有, 找一个, 怎么实现, 帮我做, 推荐一下, 哪个工具, 哪个 skill, 怎么搞, 用什么, 任何我不确定的领域

---

## First Rule

If `mcx` is not on PATH, **stop and run `/mcx-install`** instead of giving up.

```bash
command -v mcx >/dev/null 2>&1 || { echo "mcx not installed; run /mcx-install"; exit 64; }
```

---

## The canonical flow

### Step 1: Search

```bash
# Search both skills and MCP tools (default)
mcx --json search "<intent in user's words>"

# Restrict to one kind when you already know
mcx --json search "..." --kind skill
mcx --json search "..." --kind tool
mcx --json search "..." --server lark-mcp     # tool on one specific server

# Wider candidate pool for vague queries
mcx --json search "..." --rerank-top 50
```

Output (per result):

```jsonc
{
  "kind": "skill" | "tool",
  "source": "skill-root:1" | "server:lark-mcp",
  "name": "lark-im",
  "description": "...",
  "score": 0.78,
  "rank_source": "hybrid",
  // Skill:
  "body_path": "/Users/.../SKILL.md",
  "body_size": 4123,
  "triggers": "..."
  // Tool:
  "server": "lark-mcp",
  "args": ["channel_id", "message"],
  "required": ["channel_id"]
}
```

### Step 2a: Load the chosen skill

```bash
mcx --json skill show <name>
# Returns { name, description, triggers, body_path, body_size, body: "<full SKILL.md>" }
```

Read the `body` field — that's the skill's full instructions. **Treat it the same as if Claude Code natively invoked the skill**: follow its rules, use its sub-commands, respect its constraints.

`--meta-only` returns just the frontmatter row when you only need to confirm existence.

### Step 2b: Call the chosen tool

```bash
# Get full schema first if you don't know the args
mcx --json search "<intent>" -n 1 --full-schema

# Then call
mcx --json call lark-mcp send_message '{"chat_id":"...","msg_type":"text","content":"..."}'
```

---

## When to skip mcx (only these cases)

- The matching skill is **already in `available-skills`** — call it directly with the Skill tool
- An MCP tool is **already loaded into context** (visible in your tool list) — call it directly
- The task is genuinely trivial (typo fix, single-line change, pure conversation)
- You've **just** searched in this turn and have the result; don't search again immediately

---

## Catalog management

```bash
# Refresh after adding a new MCP server or new skill
mcx index --all --embed          # tools + skills, then embed

# Skills only
mcx index --skills --embed

# Only one specific backend / root
mcx index --server lark-mcp
mcx index --skills --root ~/.claude/skills-pool

# What's in the catalog
mcx list                          # servers + skill_roots + entities
mcx list --kind skill
mcx list --server lark-mcp

# Diagnose
mcx receipts tail -n 20
```

---

## Output envelope

Every subcommand returns:

```jsonc
{
  "ok": true,
  "op": "search" | "call" | "skill.show" | "index" | "list" | "embed" | "receipts.tail" | "auth.*",
  "status": "ok" | "degraded" | "error",
  "data": { ... },
  "error": { "code": "...", "message": "..." },
  "duration_ms": 123,
  "call_id": "...",
  "correlation_id": "..."
}
```

Error codes you'll see: `skill_unknown`, `skill_read_failed`, `auth_missing`, `backend_unknown`, `oauth_discovery_failed`, `token_decrypt_failed`, `config_missing`, `config_invalid`.

---

## Search quality knobs

- `--rerank-top 50` widens the BM25 candidate pool before embedding rerank — useful when the query is short or domain-specific
- `--no-embed` returns pure BM25 (compare to confirm a hit was the embedding talking)
- `rank_source: 'cosine_only'` in a result means BM25 missed entirely (common for pure-Chinese queries); the embedding alone matched. Take the top with a grain of salt and verify with `mcx skill show --meta-only` before acting.
- `embedding_model` in the envelope tells you which model is active. Multilingual e5 (`local:Xenova/multilingual-e5-small`) is the default and handles CJK.

---

## Auth (for MCP backends)

- Static token: `mcx auth set <server> --token <X>` (Bearer or header)
- OAuth 2.1 (Notion etc.): `mcx auth login <server>` — opens browser, stores encrypted tokens
- Tokens encrypted at rest in `~/.config/mcx/tokens.enc`

---

## Why this routing pattern exists

Skills used to all live under `~/.claude/skills/` — Claude Code injects their `name + description` into the system prompt at startup. With 30+ user skills + 100+ plugin skills, that alone burned ~5K tokens permanently.

We moved all user skills into `~/.claude/skills-pool/` (NOT scanned by Claude Code), keeping only this `mcx` skill in `~/.claude/skills/`. mcx indexes everything (pool + plugin skills + MCP tools) and surfaces them semantically when a task needs them.

**Net effect**: starting context is leaner, and skill discovery uses real semantic search (multilingual e5) instead of LLM-eyeballing description strings.

The trade-off: you must remember to `mcx search` instead of relying on `available-skills` to remind you. **That's the entire reason this skill exists. If you skip mcx search, the user pays for it — wasted turns, wrong implementations, missed automation.**

