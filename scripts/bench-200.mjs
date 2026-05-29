#!/usr/bin/env node
// Generate 200 natural-language queries using Haiku, then evaluate with mcx.
import { readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

const TOKEN = process.env.ANTHROPIC_AUTH_TOKEN
const BASE = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'
const SAMPLES = '/Users/beta/.claude/jobs/bd7b8c63/tmp/sample-set-200.json'
const PROMPTS_OUT = '/Users/beta/.claude/jobs/bd7b8c63/tmp/prompts-200.json'
const RESULTS_OUT = '/Users/beta/.claude/jobs/bd7b8c63/tmp/recall-results-200.json'
const MCX_CLI = '/Users/beta/.claude/plugins/marketplaces/mcx/.claude/worktrees/mcx-skill-unified/dist/cli.js'

const STYLES_NORMAL = ['口语', '正式', '英文', '问句', '动词开头']
const STYLES_BONUS = ['模糊短语', '错字口误', '关键词堆叠', '双语夹杂', '反问', '极简3-6字']

function stripJson(text) {
  // Strip ```json ... ``` fences if present
  const m = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  return m ? m[1] : text
}

async function callHaiku(prompt, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(`${BASE}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': TOKEN,
          'anthropic-version': '2023-06-01',
          'X-Sub-Module': 'claude-code-internal',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 200,
          messages: [{ role: 'user', content: prompt }],
        }),
      })
      if (!r.ok) {
        const errText = await r.text()
        if (attempt < retries) {
          await new Promise(res => setTimeout(res, 1000 * (attempt + 1)))
          continue
        }
        return { error: `HTTP ${r.status}: ${errText.slice(0, 200)}` }
      }
      const data = await r.json()
      const text = data.content?.[0]?.text ?? ''
      const json = stripJson(text)
      try {
        return { result: JSON.parse(json) }
      } catch (e) {
        return { error: 'parse: ' + json.slice(0, 200) }
      }
    } catch (e) {
      if (attempt < retries) {
        await new Promise(res => setTimeout(res, 1000 * (attempt + 1)))
        continue
      }
      return { error: 'fetch: ' + (e.message ?? String(e)) }
    }
  }
}

function buildPrompt(skill, isBonus) {
  const styles = isBonus ? STYLES_BONUS : STYLES_NORMAL
  const styleHint = styles.join(' / ')
  return [
    '你是用户行为模拟器。根据下面这个 Claude skill 的描述,生成 1 条用户可能输入的自然语言查询。',
    '要求:',
    '- 长度 8-25 字(若选 "极简3-6字" 风格则 3-6 字)',
    '- 用真实用户口吻,不要复读 description',
    `- 风格从 [${styleHint}] 中任选 1 种`,
    '- 不要直接出现 skill 的 name 字符串(测真实场景下用户自然提问)',
    '- 中文为主,允许少量英文混入(英文风格则全英文)',
    '',
    `Skill name: ${skill.name}`,
    `Skill description: ${skill.description}`,
    '',
    '输出严格 JSON: {"text": "...", "style": "..."}',
  ].join('\n')
}

const samples = JSON.parse(readFileSync(SAMPLES, 'utf-8'))
console.log(`Generating ${samples.length} queries via Haiku...`)
const t0 = Date.now()

// Concurrency: Anthropic API can handle 10-15 parallel
const CONCURRENCY = 10
const results = new Array(samples.length)
let inflight = 0
let nextIdx = 0
let done = 0
let failed = 0

await new Promise((resolve) => {
  const launch = () => {
    if (done === samples.length) { resolve(); return }
    while (inflight < CONCURRENCY && nextIdx < samples.length) {
      const idx = nextIdx++
      inflight++
      const skill = samples[idx]
      const prompt = buildPrompt(skill, skill._bonus)
      callHaiku(prompt).then(({ result, error }) => {
        if (error || !result?.text) {
          failed++
          results[idx] = null
        } else {
          results[idx] = {
            query: result.text,
            style: result.style ?? (skill._bonus ? 'bonus' : 'normal'),
            expected: skill.name,
            bonus: !!skill._bonus,
          }
        }
        inflight--
        done++
        if (done % 25 === 0) {
          const elapsed = Math.round((Date.now() - t0) / 1000)
          console.log(`  generated ${done}/${samples.length}  (${elapsed}s, failed=${failed})`)
        }
        launch()
      })
    }
  }
  launch()
})

const valid = results.filter(Boolean)
console.log(`\nGeneration done: ${valid.length}/${samples.length} valid (${failed} failed)`)
writeFileSync(PROMPTS_OUT, JSON.stringify(valid, null, 2))
console.log(`Prompts saved to ${PROMPTS_OUT}`)

// === Evaluate ===
console.log(`\nEvaluating ${valid.length} prompts via mcx search...`)

function runMcx(query) {
  return new Promise((resolve) => {
    const p = spawn('bun', [MCX_CLI, '--json', 'search', query, '--kind', 'skill', '-n', '10'])
    let stdout = '', stderr = ''
    p.stdout.on('data', d => stdout += d.toString())
    p.stderr.on('data', d => stderr += d.toString())
    p.on('close', () => {
      try {
        const env = JSON.parse(stdout)
        resolve({
          ok: env.ok,
          results: env.data?.results ?? [],
          bm25_hits: env.data?.bm25_hits ?? 0,
          cosine_fallback: env.data?.cosine_fallback_used ?? false,
          duration_ms: env.duration_ms,
        })
      } catch {
        resolve({ ok: false, results: [], error: stderr.slice(0, 200) })
      }
    })
  })
}

const t1 = Date.now()
const evals = []
let edone = 0
for (const p of valid) {
  const r = await runMcx(p.query)
  const rank = r.results.findIndex(x => x.name === p.expected)
  evals.push({
    query: p.query,
    style: p.style,
    bonus: p.bonus,
    expected: p.expected,
    rank,
    top1: r.results[0]?.name ?? null,
    top1_score: r.results[0]?.score ?? null,
    top10_names: r.results.map(x => x.name),
    bm25_hits: r.bm25_hits,
    cosine_fallback: r.cosine_fallback,
    duration_ms: r.duration_ms,
  })
  edone++
  if (edone % 20 === 0) {
    const elapsed = Math.round((Date.now() - t1) / 1000)
    console.log(`  evaluated ${edone}/${valid.length}  (${elapsed}s)`)
  }
}

const total = evals.length
const top1 = evals.filter(e => e.rank === 0).length
const top3 = evals.filter(e => e.rank >= 0 && e.rank < 3).length
const top5 = evals.filter(e => e.rank >= 0 && e.rank < 5).length
const top10 = evals.filter(e => e.rank >= 0).length

const byStyle = {}
for (const e of evals) {
  const k = e.style || 'unknown'
  if (!byStyle[k]) byStyle[k] = { n: 0, t1: 0, t3: 0, t5: 0, t10: 0 }
  byStyle[k].n++
  if (e.rank === 0) byStyle[k].t1++
  if (e.rank >= 0 && e.rank < 3) byStyle[k].t3++
  if (e.rank >= 0 && e.rank < 5) byStyle[k].t5++
  if (e.rank >= 0) byStyle[k].t10++
}

const byBonus = { normal: { n: 0, t1: 0, t3: 0, t5: 0, t10: 0 }, bonus: { n: 0, t1: 0, t3: 0, t5: 0, t10: 0 } }
for (const e of evals) {
  const t = e.bonus ? byBonus.bonus : byBonus.normal
  t.n++
  if (e.rank === 0) t.t1++
  if (e.rank >= 0 && e.rank < 3) t.t3++
  if (e.rank >= 0 && e.rank < 5) t.t5++
  if (e.rank >= 0) t.t10++
}

const byPath = { cosine: { n: 0, t1: 0, t3: 0, t5: 0, t10: 0 }, bm25: { n: 0, t1: 0, t3: 0, t5: 0, t10: 0 } }
for (const e of evals) {
  const t = e.cosine_fallback ? byPath.cosine : byPath.bm25
  t.n++
  if (e.rank === 0) t.t1++
  if (e.rank >= 0 && e.rank < 3) t.t3++
  if (e.rank >= 0 && e.rank < 5) t.t5++
  if (e.rank >= 0) t.t10++
}

const pct = (n, d) => d > 0 ? `${((n/d)*100).toFixed(0)}%` : 'n/a'
const fmt = (v) => ({ n: v.n, top1: pct(v.t1, v.n), top3: pct(v.t3, v.n), top5: pct(v.t5, v.n), top10: pct(v.t10, v.n) })

const summary = {
  total,
  top1_recall: pct(top1, total),
  top3_recall: pct(top3, total),
  top5_recall: pct(top5, total),
  top10_recall: pct(top10, total),
  miss_count: total - top10,
  avg_search_ms: Math.round(evals.reduce((a, b) => a + (b.duration_ms || 0), 0) / total),
}

const report = {
  summary,
  by_style: Object.fromEntries(Object.entries(byStyle).map(([k, v]) => [k, fmt(v)])),
  by_bonus: { normal: fmt(byBonus.normal), bonus: fmt(byBonus.bonus) },
  by_path: { cosine_fallback: fmt(byPath.cosine), bm25_first: fmt(byPath.bm25) },
  misses: evals.filter(e => e.rank === -1).map(e => ({
    query: e.query, style: e.style, expected: e.expected, top1: e.top1,
  })),
}

writeFileSync(RESULTS_OUT, JSON.stringify({ report, evals }, null, 2))
console.log('\n=== Report ===')
console.log(JSON.stringify(report.summary, null, 2))
console.log('\n=== By Style ===')
console.log(JSON.stringify(report.by_style, null, 2))
console.log('\n=== Normal vs Bonus (challenging styles) ===')
console.log(JSON.stringify(report.by_bonus, null, 2))
console.log('\n=== BM25 vs Cosine ===')
console.log(JSON.stringify(report.by_path, null, 2))
console.log(`\nMiss count: ${report.misses.length}`)
console.log(`Full data: ${RESULTS_OUT}`)
