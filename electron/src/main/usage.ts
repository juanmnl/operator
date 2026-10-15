// Token usage and insights, aggregated from every Claude Code transcript on disk. Ported from
// `src-tauri/src/usage.rs`.
//
// The source is `~/.claude/projects/<slug>/*.jsonl` — the same files the tailer follows, read
// whole rather than followed — plus each session's subagent transcripts under
// `<slug>/<session>/subagents/**/*.jsonl`, which are the only record of what subagents spent.
// That is thousands of files, so each file's parse is kept until its size or mtime changes, the
// merged result is cached for 30s, and the aggregation is a single pass.
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join, basename } from 'node:path'
import type { UsageStats, UsageInsights, TuningData, EffortUsage } from '../../../src/shared/types'

/** $/1M tokens, (input, output, cache-read).
 *
 *  SOURCE: the model catalog built into Claude Code 2.1.300 (`pricing_tiers` and the fast-mode
 *  table in its billing lookup `tNt`), read from the binary on 2026-10-14. Claude Code prices a
 *  turn from those tables, so matching them is what makes this page agree with `/cost`.
 *
 *  Explicit rows for the ids whose price differs from their family come first; the substring
 *  fallbacks after them cover dated ids (`claude-opus-5-20260101`) and point releases nobody has
 *  priced yet, which inherit their family's tier.
 *
 *  PESSIMISTIC WHERE THE ID IS AMBIGUOUS. An unknown model bills at the Opus rate rather than at
 *  zero, because a silent 0 reads as "this cost nothing". The same rule decides the bare aliases:
 *  a version-less `sonnet` (rare — transcripts carry full ids, but `<synthetic>` rows and
 *  hand-written fixtures exist) takes the HIGHER 3/15 of Sonnet 4.6, and only a confident
 *  `sonnet-5` match takes 2/10. Under-reporting is the failure this module refuses.
 *
 *  CACHE-READ IS A RATE, NOT A MULTIPLIER. It is 0.1× input on most models, but not on Opus 5.5
 *  (0.20 against 4), Sonnet 5.5 (0.10 against 2), Fable 5.1 and Mythos 5.1 (0.25 against 10),
 *  or Opus 5.5 fast (0.40 against 8). Those rows state it; the rest derive it.
 *
 *  `promptTokens` is input + cache read + cache write. Haiku 5.5 bills the whole turn at a higher
 *  tier when it exceeds 100K, as Claude Code does; no other model has a long-prompt tier.
 *
 *  `fast` is Opus fast mode (`usage.speed === 'fast'`). Claude Code bills it per model: Opus 5.5
 *  at 8/40, Opus 5 and 4.8 at 10/50, Opus 4.6 and 4.7 at 30/150. Any other Opus id falls through
 *  to its standard rate, as it does in `tNt` (the 30/150 shown in the fast-mode picker is a
 *  display string, not the billing path). No other family consults the flag. */
function rates(model: string, fast = false, promptTokens = 0): [number, number, number] {
  /** Cache-read defaults to a tenth of input — derived, never hand-copied, so the two can't drift. */
  const tier = (input: number, output: number): [number, number, number] => [input, output, input * 0.1]
  if (model.includes('haiku-5-5')) return promptTokens > 100_000 ? [0.5, 2.5, 0.05] : [0.1, 0.5, 0.01]
  if (model.includes('fable-5-1') || model.includes('mythos-5-1')) return [10, 50, 0.25]
  if (model.includes('opus-5-5')) return fast ? [8, 40, 0.4] : [4, 20, 0.2]
  if (model.includes('sonnet-5-5')) return [2, 10, 0.1]
  // Opus 4.0 and 4.1. The pattern is Claude Code's own: `opus-4` not followed by a single-digit
  // segment, so `claude-opus-4` and `claude-opus-4-20250514` match and `claude-opus-4-8` does not.
  if (model.includes('opus-4-1') || /opus-4(?!-\d(?!\d))/.test(model)) return tier(15, 75)
  if (model.includes('fable') || model.includes('mythos')) return tier(10, 50)
  if (model.includes('opus')) {
    if (fast && (model.includes('opus-5') || model.includes('opus-4-8'))) return tier(10, 50)
    if (fast && (model.includes('opus-4-6') || model.includes('opus-4-7'))) return tier(30, 150)
    return tier(5, 25)
  }
  if (model.includes('sonnet-5')) return tier(2, 10)
  if (model.includes('sonnet')) return tier(3, 15)
  if (model.includes('haiku')) return tier(1, 5)
  return tier(5, 25)
}

/** Claude Code 2.1.300 writes each API request's system prompt, tools and parameters into the
 *  transcript as `api-request`, `api-request-shape` and `api-request-blob` records — about half
 *  of a recent file's bytes, and nothing this app reads. Each starts with its own type, so a
 *  string test drops them before `JSON.parse` pays for them. The three types are matched exactly:
 *  a future `api-request-*` type may carry something worth reading, and must reach the parser.
 *  Shared with the tailer. */
const API_REQUEST_PREFIXES = ['{"type":"api-request"', '{"type":"api-request-shape"', '{"type":"api-request-blob"']
export const isApiRequestLine = (line: string) => API_REQUEST_PREFIXES.some((p) => line.startsWith(p))

/** Named `UsageRecord`, not `Record` — a local `Record` shadows TypeScript's built-in
 *  `Record<K, V>` utility type, and the errors it produces point at the USES, not the cause. */
interface UsageRecord {
  day: string; model: string; slug: string; session: string
  tsMs: number; durationMs: number
  /** `sidechain` is the record's own `isSidechain`: true on every record in a subagent transcript,
   *  and on the sidechain turns older Claude Code versions wrote into the parent file. */
  context: number; sidechain: boolean; skill?: string
  /** Effort as the TRANSCRIPT reports it — a top-level sibling of `timestamp`, present on 100%
   *  of assistant records (measured: 68,972 of 69,022 across 300 real transcripts, values
   *  `high` / `medium` / `low`). This is the RUNNING value, so it catches a mid-session
   *  `/effort` that the roster's launch pin cannot. */
  effort?: string
  /** `usage.speed === 'fast'` — Opus fast mode, billed at the premium rate. See `rates`. */
  fast: boolean
  input: number; output: number; cacheRead: number; cache5m: number; cache1h: number
  /** `${message.id}:${requestId}`, the de-duplication key. Absent when the message has no id. */
  key?: string
}

/** Cache-write is billed ABOVE the input rate (1.25× for 5-minute, 2× for 1-hour); cache-read is
 *  its own rate from the table, not a multiplier applied here. Flattening any of it to one number
 *  would misreport this app's usage badly — a long agent session is mostly cache traffic. */
function cost(r: UsageRecord): number {
  const [ri, ro, rcr] = rates(r.model, r.fast, r.context)
  const perIn = ri / 1e6
  return r.input * perIn + r.output * (ro / 1e6) + r.cacheRead * (rcr / 1e6) + r.cache5m * perIn * 1.25 + r.cache1h * perIn * 2
}
const tokensOf = (r: UsageRecord) => r.input + r.output + r.cacheRead + r.cache5m + r.cache1h

let cache: { at: number; recs: UsageRecord[]; compactions: CompactionRecord[] } | null = null
const CACHE_TTL_MS = 30_000

/** Each transcript's parse, kept for the life of the app and reused while the file's size and
 *  mtime are unchanged. A finished session or subagent file never changes again, so after the
 *  first scan only the files being written are read. */
interface ParsedFile { size: number; mtimeMs: number; recs: UsageRecord[]; compactions: CompactionRecord[] }
const parsed = new Map<string, ParsedFile>()

/** Drop the cache. For tests, which write transcripts into a sandbox between calls and would
 *  otherwise read the previous test's answer for 30 seconds. */
export function resetUsageCache(): void { cache = null; parsed.clear() }

/** Add `r` to `list` unless a record with its key is already there.
 *
 *  A message is re-emitted as a turn streams, so the same (id, requestId) appears many times;
 *  without this the totals are several times the truth. The copies are not identical in subagent
 *  transcripts: `output_tokens` grows with each emission (first-seen sums to 13% of the final
 *  output), so the copy with the LARGER output keeps its usage. The stored record's identity
 *  (session, sidechain flag, timestamp) stays, so a fork's replay of a parent turn, which has the
 *  same usage, remains the parent's turn. Records are never mutated: they live in `parsed`. */
function keep(list: UsageRecord[], index: Map<string, number>, r: UsageRecord): void {
  if (!r.key) { list.push(r); return }
  const i = index.get(r.key)
  if (i === undefined) { index.set(r.key, list.length); list.push(r); return }
  const s = list[i]
  if (r.output > s.output) {
    list[i] = { ...s, input: r.input, output: r.output, cacheRead: r.cacheRead, cache5m: r.cache5m, cache1h: r.cache1h, context: r.context, fast: r.fast }
  }
}

interface TranscriptFile { path: string; slug: string; session: string; subagent: boolean }

/** Every `.jsonl` under a session's `subagents/` directory, at any depth: `agent-<id>.jsonl`
 *  directly, and workflow agents under `workflows/<id>/`. */
async function subagentFiles(dir: string, slug: string, session: string, out: TranscriptFile[]): Promise<void> {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const path = join(dir, e.name)
    if (e.isDirectory()) await subagentFiles(path, slug, session, out)
    else if (extname(e.name) === '.jsonl') out.push({ path, slug, session, subagent: true })
  }
}

async function load(): Promise<{ recs: UsageRecord[]; compactions: CompactionRecord[] }> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache
  const projectsDir = join(homedir(), '.claude', 'projects')

  let dirs
  try { dirs = await readdir(projectsDir, { withFileTypes: true }) } catch { return { recs: [], compactions: [] } }
  const files: TranscriptFile[] = []
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const slug = dir.name
    let entries
    try { entries = await readdir(join(projectsDir, slug), { withFileTypes: true }) } catch { continue }
    // Parent transcripts first, so that on an equal-usage repeat (a fork replaying its parent's
    // turns) the parent's copy is the one kept.
    for (const e of entries) {
      if (extname(e.name) === '.jsonl') files.push({ path: join(projectsDir, slug, e.name), slug, session: basename(e.name, '.jsonl'), subagent: false })
    }
    // Only `<session>/subagents/` is walked; a session directory also holds tool-result folders
    // and other files that are not transcripts. Subagent records belong to the parent session.
    for (const e of entries) {
      if (e.isDirectory()) await subagentFiles(join(projectsDir, slug, e.name, 'subagents'), slug, e.name, files)
    }
  }

  const out: UsageRecord[] = []
  const compactions: CompactionRecord[] = []
  // ONE index across parent and subagent files, so a turn that appears in both counts once.
  const index = new Map<string, number>()
  const live = new Set<string>()
  for (const f of files) {
    let st
    try { st = await stat(f.path) } catch { continue }
    live.add(f.path)
    let p = parsed.get(f.path)
    if (!p || p.size !== st.size || p.mtimeMs !== st.mtimeMs) {
      let raw: string
      try { raw = await readFile(f.path, 'utf8') } catch { continue }
      p = { size: st.size, mtimeMs: st.mtimeMs, ...parseTranscript(raw, f) }
      parsed.set(f.path, p)
    }
    for (const r of p.recs) keep(out, index, r)
    compactions.push(...p.compactions)
  }
  // A deleted transcript must not keep its parse alive for the rest of the run.
  for (const path of parsed.keys()) if (!live.has(path)) parsed.delete(path)

  cache = { at: Date.now(), recs: out, compactions }
  return cache
}

/** One transcript's usage records (already de-duplicated within the file) and compaction
 *  boundaries. */
function parseTranscript(raw: string, f: TranscriptFile): { recs: UsageRecord[]; compactions: CompactionRecord[] } {
  const { slug, session } = f
  const recs: UsageRecord[] = []
  const index = new Map<string, number>()
  const compactions: CompactionRecord[] = []
  for (const line of raw.split('\n')) {
    if (!line || isApiRequestLine(line)) continue
    // Only usage records and compaction boundaries are read; every other line is skipped before
    // `JSON.parse`, which is most of the cost of a scan.
    if (!line.includes('"usage"') && !line.includes('compact_boundary')) continue
    let obj: RawLine
    try { obj = JSON.parse(line) } catch { continue }
    // COMPACTION BOUNDARIES ride the same pass. They carry no `usage`, so the guard below
    // would drop them — and a second walk over every transcript to find them would double
    // the cost of the most expensive thing this module does.
    if (obj.type === 'system' && obj.subtype === 'compact_boundary') {
      // A subagent compacting its own context is not the lane compacting. None of the subagent
      // transcripts on disk had one on 2026-10-14.
      if (f.subagent) continue
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
    keep(recs, index, {
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
      key: typeof msg.id === 'string' ? `${msg.id}:${typeof obj.requestId === 'string' ? obj.requestId : ''}` : undefined,
    })
  }
  return { recs, compactions }
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
export async function computeTuning(days: number, sinceMs?: number): Promise<Omit<TuningData, 'toolOutput'>> {
  const generatedAt = new Date().toISOString()
  // `sinceMs` is passed by the IPC handler so BOTH halves of the payload share one window; see
  // `getTuning`. Absent (tests, direct callers) it falls back to deriving its own, as before.
  const cutoffDay = sinceMs !== undefined
    ? new Date(sinceMs).toISOString().slice(0, 10)
    : cutoffFor(days).cutoffDay
  const { recs, compactions } = await load()

  interface SessAcc {
    slug: string; model: string; effort?: string
    tokens: number; cost: number; turns: number
    subagentTokens: number; subagentCost: number
    highContextTurns: number; contexts: number[]
    compactions: number; reReadTokens: number; droppedTokens: number
    firstTsMs: number; lastTsMs: number
    /** Timestamp of the lane's own record that set `model` and `effort`. */
    modelTsMs: number
  }
  const newSession = (slug: string): SessAcc => ({ slug, model: '', tokens: 0, cost: 0, turns: 0, subagentTokens: 0, subagentCost: 0,
    highContextTurns: 0, contexts: [], compactions: 0, reReadTokens: 0, droppedTokens: 0, firstTsMs: 0, lastTsMs: 0, modelTsMs: 0 })
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
    if (!a) { a = newSession(r.slug); bySession.set(r.session, a) }
    a.tokens += t; a.cost += c
    if (r.sidechain) {
      // A subagent's spend is the lane's spend, so it is in `tokens` and `cost`. It is not the
      // lane's turn: a 15k-token subagent context would drag the lane's median down, and a Sonnet
      // subagent would relabel an Opus lane. `transcript.ts` keeps them out of lane state too.
      a.subagentTokens += t; a.subagentCost += c
    } else {
      a.turns += 1
      // LATEST WINS for model and effort: a session that switched mid-window is described by what
      // it is running now, and the per-(model, effort) split below is where the change stays visible.
      if (r.tsMs >= a.modelTsMs) { a.model = r.model; if (r.effort) a.effort = r.effort; a.modelTsMs = r.tsMs }
      if (r.context > 150_000) a.highContextTurns += 1
      a.contexts.push(r.context)
    }
    if (r.tsMs > 0) {
      a.firstTsMs = a.firstTsMs ? Math.min(a.firstTsMs, r.tsMs) : r.tsMs
      a.lastTsMs = Math.max(a.lastTsMs, r.tsMs)
    }

    // The triple. A lane that ran half a window on High and half on Medium becomes two rows, not
    // one averaged row that describes neither half. Subagent records stay in at the effort they
    // ran at, so the rows still sum to `totalCost`.
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
    if (!a) { a = newSession(cb.slug); bySession.set(cb.session, a) }
    a.compactions += 1
    a.reReadTokens += cb.postTokens
    a.droppedTokens += Math.max(0, cb.preTokens - cb.postTokens)
  }

  return {
    days, totalTokens, totalCost, generatedAt,
    bySession: [...bySession].map(([session, a]) => ({
      session, slug: a.slug, model: a.model, effort: a.effort,
      tokens: a.tokens, cost: a.cost, turns: a.turns,
      subagentTokens: a.subagentTokens, subagentCost: a.subagentCost,
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
