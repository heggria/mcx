#!/usr/bin/env node
// Re-evaluate the existing 200-prompt set with --rerank, compare to baseline.
import { readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

const PROMPTS = '/Users/beta/.claude/jobs/bd7b8c63/tmp/prompts-200.json'
const BASELINE_RESULTS = '/Users/beta/.claude/jobs/bd7b8c63/tmp/recall-results-200.json'
const OUT = '/Users/beta/.claude/jobs/bd7b8c63/tmp/recall-results-200-rerank.json'
const MCX_CLI = '/Users/beta/.claude/plugins/marketplaces/mcx/.claude/worktrees/mcx-skill-unified/dist/cli.js'

const prompts = JSON.parse(readFileSync(PROMPTS, 'utf-8'))
const baseline = JSON.parse(readFileSync(BASELINE_RESULTS, 'utf-8')).evals
const baselineByQuery = new Map(baseline.map(e => [e.query, e]))

function runMcx(query, useRerank) {
  return new Promise((resolve) => {
    const args = [MCX_CLI, '--json', 'search', query, '--kind', 'skill', '-n', '10']
    if (useRerank) args.push('--rerank', '--rerank-pool', '10')
    const p = spawn('bun', args, {
      env: {
        ...process.env,
        ANTHROPIC_AUTH_TOKEN: 'sk-2pNgqETYTgNrd8SRe5gfr7rkQo7GNwmeMoMOkVh01F0GuScI',
        ANTHROPIC_BASE_URL: 'https://platform-api.xaminim.com',
        ANTHROPIC_CUSTOM_HEADERS: 'X-Sub-Module: claude-code-internal',
      },
    })
    let stdout = '', stderr = ''
    p.stdout.on('data', d => stdout += d.toString())
    p.stderr.on('data', d => stderr += d.toString())
    p.on('close', () => {
      try {
        const env = JSON.parse(stdout)
        resolve({
          ok: env.ok,
          results: env.data?.results ?? [],
          rerank: env.data?.rerank ?? null,
          duration_ms: env.duration_ms,
        })
      } catch {
        resolve({ ok: false, results: [], error: stderr.slice(0, 200) })
      }
    })
  })
}

console.log(`Evaluating ${prompts.length} prompts with --rerank...`)
const t0 = Date.now()
const evals = []
let done = 0
let rerankFailed = 0
let topImprove = 0
let topRegress = 0
for (const p of prompts) {
  const r = await runMcx(p.query, true)
  const rank = r.results.findIndex(x => x.name === p.expected)
  const baselineEval = baselineByQuery.get(p.query)
  const baselineRank = baselineEval?.rank ?? -1
  const improved = (rank >= 0 && (baselineRank < 0 || rank < baselineRank))
  const regressed = (baselineRank >= 0 && (rank < 0 || rank > baselineRank))
  if (improved) topImprove++
  if (regressed) topRegress++
  if (r.rerank && !r.rerank.ok) rerankFailed++
  evals.push({
    query: p.query,
    style: p.style,
    bonus: p.bonus,
    expected: p.expected,
    rank,
    baseline_rank: baselineRank,
    improved,
    regressed,
    top1: r.results[0]?.name ?? null,
    top10_names: r.results.map(x => x.name),
    rerank_ok: r.rerank?.ok ?? null,
    rerank_ms: r.rerank?.duration_ms ?? null,
    duration_ms: r.duration_ms,
  })
  done++
  if (done % 20 === 0) {
    const elapsed = Math.round((Date.now() - t0) / 1000)
    console.log(`  ${done}/${prompts.length}  (${elapsed}s, rerank_failed=${rerankFailed})`)
  }
}

const total = evals.length
const top1 = evals.filter(e => e.rank === 0).length
const top3 = evals.filter(e => e.rank >= 0 && e.rank < 3).length
const top5 = evals.filter(e => e.rank >= 0 && e.rank < 5).length
const top10 = evals.filter(e => e.rank >= 0).length

const baseSummary = {
  total: baseline.length,
  top1: baseline.filter(e => e.rank === 0).length,
  top3: baseline.filter(e => e.rank >= 0 && e.rank < 3).length,
  top5: baseline.filter(e => e.rank >= 0 && e.rank < 5).length,
  top10: baseline.filter(e => e.rank >= 0).length,
}

const pct = (n, d) => d > 0 ? `${((n/d)*100).toFixed(0)}%` : 'n/a'

const compare = {
  baseline: {
    top1: pct(baseSummary.top1, baseSummary.total),
    top3: pct(baseSummary.top3, baseSummary.total),
    top5: pct(baseSummary.top5, baseSummary.total),
    top10: pct(baseSummary.top10, baseSummary.total),
  },
  with_rerank: {
    top1: pct(top1, total),
    top3: pct(top3, total),
    top5: pct(top5, total),
    top10: pct(top10, total),
  },
  delta: {
    top1: `+${top1 - baseSummary.top1} (${pct(top1, total)} vs ${pct(baseSummary.top1, baseSummary.total)})`,
    top3: `+${top3 - baseSummary.top3} (${pct(top3, total)} vs ${pct(baseSummary.top3, baseSummary.total)})`,
    top5: `+${top5 - baseSummary.top5} (${pct(top5, total)} vs ${pct(baseSummary.top5, baseSummary.total)})`,
    top10: `+${top10 - baseSummary.top10} (${pct(top10, total)} vs ${pct(baseSummary.top10, baseSummary.total)})`,
  },
  rerank_meta: {
    rerank_failed: rerankFailed,
    individual_improved: topImprove,
    individual_regressed: topRegress,
    avg_total_ms: Math.round(evals.reduce((a, b) => a + (b.duration_ms || 0), 0) / total),
    avg_rerank_ms: Math.round(evals.filter(e => e.rerank_ms).reduce((a, b) => a + b.rerank_ms, 0) / evals.filter(e => e.rerank_ms).length),
  },
}

const regressions = evals.filter(e => e.regressed).slice(0, 15).map(e => ({
  query: e.query,
  expected: e.expected,
  baseline_rank: e.baseline_rank,
  rerank_rank: e.rank,
  rerank_top1: e.top1,
}))

const improvements = evals.filter(e => e.improved && e.rank === 0).slice(0, 15).map(e => ({
  query: e.query,
  expected: e.expected,
  baseline_rank: e.baseline_rank,
  rerank_rank: e.rank,
}))

writeFileSync(OUT, JSON.stringify({ compare, regressions, improvements, evals }, null, 2))
console.log('\n=== Comparison ===')
console.log(JSON.stringify(compare, null, 2))
console.log(`\nTop regressions (rerank made it worse):`)
console.log(JSON.stringify(regressions.slice(0, 5), null, 2))
console.log(`\nTop improvements (rerank fixed a miss):`)
console.log(JSON.stringify(improvements.slice(0, 5), null, 2))
console.log(`\nFull data: ${OUT}`)
