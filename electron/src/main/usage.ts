// Token usage and insights, aggregated from every Claude Code transcript on disk. Ported from
// `src-tauri/src/usage.rs`.
//
// The source is `~/.claude/projects/<slug>/*.jsonl` — the same files the tailer follows, read
// whole rather than followed. That is thousands of files, so the parse is cached (30s) and the
// aggregation is a single pass.
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join, basename } from 'node:path'
import type { UsageStats, UsageInsights } from '../../../src/shared/types'

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

let cache: { at: number; recs: UsageRecord[] } | null = null
const CACHE_TTL_MS = 30_000

async function loadRecords(): Promise<UsageRecord[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.recs
  const projectsDir = join(homedir(), '.claude', 'projects')
  const out: UsageRecord[] = []
  // A message is re-emitted as a turn streams, so the same (id, requestId) appears many times.
  // Without this the totals are several times the truth.
  const seen = new Set<string>()

  let dirs
  try { dirs = await readdir(projectsDir, { withFileTypes: true }) } catch { return [] }
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
          input, output: g(usage, 'output_tokens'), cacheRead, cache5m, cache1h,
        })
      }
    }
  }
  cache = { at: Date.now(), recs: out }
  return out
}

interface RawLine {
  message?: { usage?: Record<string, unknown>; model?: unknown; id?: unknown }
  requestId?: unknown; timestamp?: unknown; durationMs?: unknown
  isSidechain?: unknown; attributionSkill?: unknown
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
