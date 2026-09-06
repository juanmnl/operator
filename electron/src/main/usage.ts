// Token usage and insights, aggregated from every Claude Code transcript on disk. Ported from
// `src-tauri/src/usage.rs`.
//
// The source is `~/.claude/projects/<slug>/*.jsonl` — the same files the tailer follows, read
// whole rather than followed. That is thousands of files, so the parse is cached (30s) and the
// aggregation is a single pass.
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join, basename } from 'node:path'
import type { UsageStats, UsageInsights, TuningData, EffortUsage } from '../../../src/shared/types'

/** $/1M tokens, (input, output, cache-read). Substring-matched so a dated model id
 *  (`claude-opus-5-20260101`) resolves without a table entry per release, and so a point release
 *  inherits its tier — `sonnet-5` is written to catch a future `sonnet-5-1` too.
 *
 *  PESSIMISTIC WHERE THE ID IS AMBIGUOUS. An unknown model bills at the Opus rate rather than at
 *  zero, because a silent 0 reads as "this cost nothing". The same rule decides the bare aliases:
 *  a version-less `sonnet` (rare — transcripts carry full ids, but `<synthetic>` rows and
 *  hand-written fixtures exist) takes the HIGHER 3/15 of Sonnet 4.6, and only a confident
 *  `sonnet-5` match takes 2/10. Under-reporting is the failure this module refuses.
 *
 *  CACHE-READ IS A RATE, NOT A MULTIPLIER. It is 0.1× input on every model here except Fable 5.1,
 *  which reads cache at a flat $0.25/Mtok — a quarter of what 0.1 × $10 would say, on the traffic
 *  an agent session is mostly made of. Scoped to `fable-5-1` deliberately: $0.25 is documented as
 *  something 5.1 ADDS over Fable 5, and whether Mythos 5.1 shares it is open, so `claude-fable-5`
 *  and the mythos ids keep the 0.1× default rather than take a discount nobody has confirmed.
 *
 *  `fast` is Opus fast mode (`usage.speed === 'fast'`), which bills 10/50 instead of 5/25 — the
 *  same model, 2.5× the output speed, at a premium. It is a research preview on Opus 5 and 4.8
 *  only, so no other family consults the flag; 4.8's fast rate is not separately published, and
 *  pricing it with Opus 5's is the pessimistic reading. */
function rates(model: string, fast = false): [number, number, number] {
  /** Cache-read defaults to a tenth of input — derived, never hand-copied, so the two can't drift. */
  const tier = (input: number, output: number): [number, number, number] => [input, output, input * 0.1]
  if (model.includes('fable-5-1')) return [10, 50, 0.25]
  if (model.includes('fable') || model.includes('mythos')) return tier(10, 50)
  if (model.includes('opus')) return fast ? tier(10, 50) : tier(5, 25)
  if (model.includes('sonnet-5')) return tier(2, 10)
  if (model.includes('sonnet')) return tier(3, 15)
  if (model.includes('haiku')) return tier(1, 5)
  return tier(5, 25)
}

/** Named `UsageRecord`, not `Record` — a local `Record` shadows TypeScript's built-in
 *  `Record<K, V>` utility type, and the errors it produces point at the USES, not the cause. */
interface UsageRecord {
  day: string; model: string; slug: string; session: string
  tsMs: number; durationMs: number
  context: number; sidechain: boolean; skill?: string
  /** Effort as the TRANSCRIPT reports it — a top-level sibling of `timestamp`, present on 100%
   *  of assistant records (measured: 68,972 of 69,022 across 300 real transcripts, values
   *  `high` / `medium` / `low`). This is the RUNNING value, so it catches a mid-session
   *  `/effort` that the roster's launch pin cannot. */
  effort?: string
  /** `usage.speed === 'fast'` — Opus fast mode, billed at the premium rate. See `rates`. */
  fast: boolean
  input: number; output: number; cacheRead: number; cache5m: number; cache1h: number
}

/** Cache-write is billed ABOVE the input rate (1.25× for 5-minute, 2× for 1-hour); cache-read is
 *  its own rate from the table, not a multiplier applied here. Flattening any of it to one number
 *  would misreport this app's usage badly — a long agent session is mostly cache traffic. */
function cost(r: UsageRecord): number {
  const [ri, ro, rcr] = rates(r.model, r.fast)
  const perIn = ri / 1e6
  return r.input * perIn + r.output * (ro / 1e6) + r.cacheRead * (rcr / 1e6) + r.cache5m * perIn * 1.25 + r.cache1h * perIn * 2
}
const tokensOf = (r: UsageRecord) => r.input + r.output + r.cacheRead + r.cache5m + r.cache1h

let cache: { at: number; recs: UsageRecord[]; compactions: CompactionRecord[] } | null = null
const CACHE_TTL_MS = 30_000

/** Drop the cache. For tests, which write transcripts into a sandbox between calls and would
 *  otherwise read the previous test's answer for 30 seconds. */
export function resetUsageCache(): void { cache = null }

async function load(): Promise<{ recs: UsageRecord[]; compactions: CompactionRecord[] }> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache
  const projectsDir = join(homedir(), '.claude', 'projects')
  const out: UsageRecord[] = []
  const compactions: CompactionRecord[] = []
  // A message is re-emitted as a turn streams, so the same (id, requestId) appears many times.
  // Without this the totals are several times the truth.
  const seen = new Set<string>()

  let dirs
  try { dirs = await readdir(projectsDir, { withFileTypes: true }) } catch { return { recs: [], compactions: [] } }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const slug = dir.name
    let files
    try { files = await readdir(join(projectsDir, slug)) } catch { continue }
    for (const f of files) {
      if (extname(f) !== '.jsonl') continue
      const session = basename(f, '.jsonl')
      let raw: string
      try { raw = await readFile(join(projectsDir, slug, f), 'utf8') } catch { continue }
      for (const line of raw.split('\n')) {
        if (!line) continue
        let obj: RawLine
        try { obj = JSON.parse(line) } catch { continue }
        // COMPACTION BOUNDARIES ride the same pass. They carry no `usage`, so the guard below
        // would drop them — and a second walk over every transcript to find them would double
        // the cost of the most expensive thing this module does.
        if (obj.type === 'system' && obj.subtype === 'compact_boundary') {
          const cm = obj.compactMetadata
          const cts = typeof obj.timestamp === 'string' ? obj.timestamp : ''
          compactions.push({
            day: cts.slice(0, 10), slug, session,
            tsMs: cts ? Date.parse(cts) || 0 : 0,
            preTokens: typeof cm?.preTokens === 'number' ? cm.preTokens : 0,
            postTokens: typeof cm?.postTokens === 'number' ? cm.postTokens : 0,
          })
          continue
        }
        const msg = obj.message
        const usage = msg?.usage
        if (!msg || !usage) continue
        const model = typeof msg.model === 'string' ? msg.model : ''
        if (!model || model === '<synthetic>') continue
        if (typeof msg.id === 'string') {
          const key = `${msg.id}:${typeof obj.requestId === 'string' ? obj.requestId : ''}`
          if (seen.has(key)) continue
          seen.add(key)
        }
        const g = (o: Record<string, unknown> | undefined, k: string) => (typeof o?.[k] === 'number' ? (o[k] as number) : 0)
        const ccTotal = g(usage, 'cache_creation_input_tokens')
        const cc = usage.cache_creation as Record<string, unknown> | undefined
        // The 5m/1h split only exists on newer records; older ones carry a single total, which
        // is billed at the 5-minute rate rather than dropped.
        const [cache5m, cache1h] = cc && (cc.ephemeral_5m_input_tokens !== undefined || cc.ephemeral_1h_input_tokens !== undefined)
          ? [g(cc, 'ephemeral_5m_input_tokens'), g(cc, 'ephemeral_1h_input_tokens')]
          : [ccTotal, 0]
        const ts = typeof obj.timestamp === 'string' ? obj.timestamp : ''
        const input = g(usage, 'input_tokens')
        const cacheRead = g(usage, 'cache_read_input_tokens')
        out.push({
          day: ts.slice(0, 10),
          model, slug, session,
          tsMs: ts ? Date.parse(ts) || 0 : 0,
          durationMs: typeof obj.durationMs === 'number' ? obj.durationMs : 0,
          context: input + cacheRead + cache5m + cache1h,
          sidechain: obj.isSidechain === true,
          // Claude Code persists the API's own `usage.speed` verbatim; anything but the literal
          // 'fast' (including the `null` that `<synthetic>` rows carry) is the standard rate.
          fast: usage.speed === 'fast',
          skill: typeof obj.attributionSkill === 'string' && obj.attributionSkill ? obj.attributionSkill : undefined,
          effort: typeof obj.effort === 'string' && obj.effort ? obj.effort : undefined,
          input, output: g(usage, 'output_tokens'), cacheRead, cache5m, cache1h,
        })
      }
    }
  }
  cache = { at: Date.now(), recs: out, compactions }
  return cache
}

/** Back-compat for the two existing callers, which only ever wanted the usage records. */
async function loadRecords(): Promise<UsageRecord[]> {
  return (await load()).recs
}

interface RawLine {
  message?: { usage?: Record<string, unknown>; model?: unknown; id?: unknown }
  requestId?: unknown; timestamp?: unknown; durationMs?: unknown
  isSidechain?: unknown; attributionSkill?: unknown; effort?: unknown
  type?: unknown; subtype?: unknown
  compactMetadata?: { preTokens?: unknown; postTokens?: unknown }
}

/** One compaction, as the transcript records it.
 *
 *  The record is written when the compaction has FINISHED — it carries `durationMs`, `preTokens`
 *  and `postTokens` — so it closes a compaction rather than opening one. `postTokens` is the
 *  context the model must read again on the next turn, which is the cost this page reports;
 *  `preTokens - postTokens` is what was thrown away. */
interface CompactionRecord {
  day: string; slug: string; session: string; tsMs: number
  preTokens: number; postTokens: number
}

/** Claude Code slugifies a cwd into the directory name; turn it back into something readable. */
const projectName = (slug: string) => slug.replace(/^-/, '').split('-').pop() || slug

const cutoffFor = (days: number) => {
  if (days <= 0) return { cutoffDay: '', since: undefined as string | undefined }
  const iso = new Date(Date.now() - days * 86_400_000).toISOString()
  return { cutoffDay: iso.slice(0, 10), since: iso }
}

export async function computeUsage(days: number): Promise<UsageStats> {
  const generatedAt = new Date().toISOString()
  const { cutoffDay, since } = cutoffFor(days)
  const recs = await loadRecords()

  interface Acc { input: number; output: number; cacheWrite: number; cacheRead: number; cost: number; messages: number }
  const mk = (): Acc => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, messages: 0 })
  const byModel = new Map<string, Acc>()
  const byProject = new Map<string, Acc>()
  const byDay = new Map<string, { cost: number; tokens: number }>()
  let totalCost = 0, totalTokens = 0, apiMs = 0
  let minTs = Number.MAX_SAFE_INTEGER, maxTs = Number.MIN_SAFE_INTEGER

  for (const r of recs) {
    if (cutoffDay && r.day && r.day < cutoffDay) continue
    const c = cost(r), t = tokensOf(r), cacheWrite = r.cache5m + r.cache1h
    totalCost += c; totalTokens += t; apiMs += Math.max(0, r.durationMs)
    if (r.tsMs > 0) { minTs = Math.min(minTs, r.tsMs); maxTs = Math.max(maxTs, r.tsMs) }

    for (const [map, key] of [[byModel, r.model], [byProject, r.slug]] as const) {
      let a = map.get(key)
      if (!a) { a = mk(); map.set(key, a) }
      a.input += r.input; a.output += r.output; a.cacheWrite += cacheWrite; a.cacheRead += r.cacheRead; a.cost += c; a.messages += 1
    }
    const dayKey = r.day || generatedAt.slice(0, 10)
    const d = byDay.get(dayKey) ?? { cost: 0, tokens: 0 }
    d.cost += c; d.tokens += t
    byDay.set(dayKey, d)
  }

  return {
    totalCost, totalTokens, apiMs,
    // Wall time is the SPAN, not the sum: sessions overlap, and adding their durations would
    // report more hours than the day contains.
    wallMs: maxTs > minTs ? maxTs - minTs : 0,
    byModel: [...byModel].map(([model, a]) => ({
      model, inputTokens: a.input, outputTokens: a.output,
      cacheWriteTokens: a.cacheWrite, cacheReadTokens: a.cacheRead, cost: a.cost, messages: a.messages,
    })).sort((a, b) => b.cost - a.cost),
    byProject: [...byProject].map(([slug, a]) => ({
      slug, name: projectName(slug), cost: a.cost,
      tokens: a.input + a.output + a.cacheRead + a.cacheWrite, messages: a.messages,
    })).sort((a, b) => b.cost - a.cost),
    byDay: [...byDay].map(([date, v]) => ({ date, cost: v.cost, tokens: v.tokens })).sort((a, b) => a.date.localeCompare(b.date)),
    since, generatedAt,
  }
}

export async function computeInsights(days: number): Promise<UsageInsights> {
  const generatedAt = new Date().toISOString()
  const { cutoffDay, since } = cutoffFor(days)
  const recs = await loadRecords()

  let total = 0, highContext = 0
  const bySession = new Map<string, { tokens: number; sidechain: boolean; min: number; max: number }>()
  const bySkill = new Map<string, number>()

  for (const r of recs) {
    if (cutoffDay && r.day && r.day < cutoffDay) continue
    const t = tokensOf(r)
    total += t
    if (r.context > 150_000) highContext += t
    const e = bySession.get(r.session) ?? { tokens: 0, sidechain: false, min: Number.MAX_SAFE_INTEGER, max: Number.MIN_SAFE_INTEGER }
    e.tokens += t
    e.sidechain = e.sidechain || r.sidechain
    if (r.tsMs > 0) { e.min = Math.min(e.min, r.tsMs); e.max = Math.max(e.max, r.tsMs) }
    bySession.set(r.session, e)
    if (r.skill) bySkill.set(r.skill, (bySkill.get(r.skill) ?? 0) + t)
  }

  const pct = (x: number) => (total > 0 ? (x / total) * 100 : 0)
  const sessions = [...bySession.values()]
  return {
    totalTokens: total,
    highContextPct: pct(highContext),
    // Attributed per SESSION, not per record: a session that used a subagent has all of its
    // tokens counted, because the question is "how much of my work involves delegation".
    subagentPct: pct(sessions.filter((s) => s.sidechain).reduce((n, s) => n + s.tokens, 0)),
    longSessionPct: pct(sessions.filter((s) => s.min !== Number.MAX_SAFE_INTEGER && s.max - s.min >= 8 * 3_600_000).reduce((n, s) => n + s.tokens, 0)),
    skills: [...bySkill].map(([name, t]) => ({ name, pct: pct(t) })).sort((a, b) => b.pct - a.pct).slice(0, 8),
    since, generatedAt,
  }
}

// ── Tuning ───────────────────────────────────────────────────────────────────────────────────

/** The p-th percentile of a sorted array, nearest-rank. Returns 0 for an empty set rather than
 *  NaN — a lane with no tool calls has no p90, and NaN renders as a number that is not one. */
export function percentile(sorted: readonly number[], p: number): number {
  if (!sorted.length) return 0
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[i]
}

/** Median of an UNSORTED array. Copies before sorting — the caller accumulates in record order
 *  and other stats still read that order. */
export function median(values: readonly number[]): number {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

/** Everything the Tuning page reads, from one pass over the window.
 *
 *  ONE CALL rather than four, because the page renders as a whole: four round trips over a 30-day
 *  window would let the lane table, the project split and the tool stats each paint a different
 *  window as transcripts landed between them.
 *
 *  `toolOutput` is injected by the caller rather than read here — it comes from `chat.db`, which
 *  this module deliberately knows nothing about; it reads `~/.claude/projects` and nothing else.
 */
export async function computeTuning(days: number): Promise<Omit<TuningData, 'toolOutput'>> {
  const generatedAt = new Date().toISOString()
  const { cutoffDay } = cutoffFor(days)
  const { recs, compactions } = await load()

  interface SessAcc {
    slug: string; model: string; effort?: string
    tokens: number; cost: number; turns: number
    highContextTurns: number; contexts: number[]
    compactions: number; reReadTokens: number; droppedTokens: number
    firstTsMs: number; lastTsMs: number
  }
  const bySession = new Map<string, SessAcc>()
  const byEffort = new Map<string, EffortUsage>()
  const byModel = new Map<string, { input: number; output: number; cacheWrite: number; cacheRead: number; cost: number; messages: number }>()
  const byProject = new Map<string, { cost: number; tokens: number; messages: number }>()
  let totalTokens = 0, totalCost = 0

  for (const r of recs) {
    if (cutoffDay && r.day && r.day < cutoffDay) continue
    const c = cost(r), t = tokensOf(r), cacheWrite = r.cache5m + r.cache1h
    totalTokens += t; totalCost += c

    let a = bySession.get(r.session)
    if (!a) {
      a = { slug: r.slug, model: r.model, tokens: 0, cost: 0, turns: 0, highContextTurns: 0, contexts: [],
        compactions: 0, reReadTokens: 0, droppedTokens: 0, firstTsMs: 0, lastTsMs: 0 }
      bySession.set(r.session, a)
    }
    a.tokens += t; a.cost += c; a.turns += 1
    // LATEST WINS for model and effort: a session that switched mid-window is described by what
    // it is running now, and the per-(model, effort) split below is where the change stays visible.
    if (r.tsMs >= a.lastTsMs) { a.model = r.model; if (r.effort) a.effort = r.effort }
    if (r.context > 150_000) a.highContextTurns += 1
    a.contexts.push(r.context)
    if (r.tsMs > 0) {
      a.firstTsMs = a.firstTsMs ? Math.min(a.firstTsMs, r.tsMs) : r.tsMs
      a.lastTsMs = Math.max(a.lastTsMs, r.tsMs)
    }

    // The triple. A lane that ran half a window on High and half on Medium becomes two rows, not
    // one averaged row that describes neither half.
    if (r.effort) {
      const key = r.session + ' ' + r.model + ' ' + r.effort
      const e = byEffort.get(key) ?? { session: r.session, model: r.model, effort: r.effort, tokens: 0, cost: 0, turns: 0 }
      e.tokens += t; e.cost += c; e.turns += 1
      byEffort.set(key, e)
    }

    const m = byModel.get(r.model) ?? { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, messages: 0 }
    m.input += r.input; m.output += r.output; m.cacheWrite += cacheWrite; m.cacheRead += r.cacheRead; m.cost += c; m.messages += 1
    byModel.set(r.model, m)

    const p = byProject.get(r.slug) ?? { cost: 0, tokens: 0, messages: 0 }
    p.cost += c; p.tokens += t; p.messages += 1
    byProject.set(r.slug, p)
  }

  // Compactions fold in after the usage records, against the same window. A session whose ONLY
  // record in the window is a boundary still gets a row: it compacted, which is exactly what this
  // page exists to show, and dropping it would make the column lie by omission.
  for (const cb of compactions) {
    if (cutoffDay && cb.day && cb.day < cutoffDay) continue
    let a = bySession.get(cb.session)
    if (!a) {
      a = { slug: cb.slug, model: '', tokens: 0, cost: 0, turns: 0, highContextTurns: 0, contexts: [],
        compactions: 0, reReadTokens: 0, droppedTokens: 0, firstTsMs: 0, lastTsMs: 0 }
      bySession.set(cb.session, a)
    }
    a.compactions += 1
    a.reReadTokens += cb.postTokens
    a.droppedTokens += Math.max(0, cb.preTokens - cb.postTokens)
  }

  return {
    days, totalTokens, totalCost, generatedAt,
    bySession: [...bySession].map(([session, a]) => ({
      session, slug: a.slug, model: a.model, effort: a.effort,
      tokens: a.tokens, cost: a.cost, turns: a.turns,
      highContextTurns: a.highContextTurns, medianContext: median(a.contexts),
      compactions: a.compactions, reReadTokens: a.reReadTokens, droppedTokens: a.droppedTokens,
      firstTsMs: a.firstTsMs, lastTsMs: a.lastTsMs,
    })).sort((x, y) => y.tokens - x.tokens),
    byEffort: [...byEffort.values()].sort((x, y) => y.tokens - x.tokens),
    byModel: [...byModel].map(([model, a]) => ({
      model, inputTokens: a.input, outputTokens: a.output,
      cacheWriteTokens: a.cacheWrite, cacheReadTokens: a.cacheRead, cost: a.cost, messages: a.messages,
    })).sort((x, y) => y.cost - x.cost),
    byProject: [...byProject].map(([slug, a]) => ({
      slug, name: projectName(slug), cost: a.cost, tokens: a.tokens, messages: a.messages,
    })).sort((x, y) => y.tokens - x.tokens),
  }
}
