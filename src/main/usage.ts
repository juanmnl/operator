import { readFileSync, readdirSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { UsageStats, ModelUsage, ProjectUsage, DayUsage } from '../shared/types'

const projectsDir = join(homedir(), '.claude', 'projects')

// $/MTok (input, output) per model family. Cache write/read derived from input:
// 5m write = 1.25×, 1h write = 2×, read = 0.1× (per Claude prompt-caching pricing).
const PRICING: Record<string, { input: number; output: number }> = {
  fable: { input: 10, output: 50 },
  opus: { input: 5, output: 25 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 1, output: 5 },
}

function rates(model: string): { input: number; output: number } {
  if (/fable|mythos/.test(model)) return PRICING.fable
  if (/opus/.test(model)) return PRICING.opus
  if (/sonnet/.test(model)) return PRICING.sonnet
  if (/haiku/.test(model)) return PRICING.haiku
  return PRICING.opus // unknown model — assume Opus-tier
}

interface Acc {
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  cost: number
  messages: number
}

function emptyAcc(): Acc {
  return { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, cost: 0, messages: 0 }
}

function lineCost(model: string, input: number, output: number, cacheRead: number, cache5m: number, cache1h: number): number {
  const r = rates(model)
  const perInput = r.input / 1e6
  const perOutput = r.output / 1e6
  return (
    input * perInput +
    output * perOutput +
    cacheRead * perInput * 0.1 +
    cache5m * perInput * 1.25 +
    cache1h * perInput * 2
  )
}

/** Friendly project name from a Claude Code project-dir slug (cwd with `/`→`-`). */
function projectName(slug: string): string {
  const parts = slug.split('-').filter(Boolean)
  return parts[parts.length - 1] || slug
}

/**
 * Parse Claude Code transcripts (~/.claude/projects/<slug>/<session>.jsonl) and
 * aggregate token usage + cost. `days` limits to recent activity (default 30).
 */
export function computeUsage(days = 30): UsageStats {
  const generatedAt = new Date().toISOString()
  const cutoffMs = days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : 0
  const since = days > 0 ? new Date(cutoffMs).toISOString() : undefined

  const byModel = new Map<string, Acc>()
  const byProject = new Map<string, Acc & { slug: string }>()
  const byDay = new Map<string, Acc>()
  const seen = new Set<string>() // dedupe message.id:requestId across sidechain duplicates
  let totalCost = 0
  let totalTokens = 0

  if (!existsSync(projectsDir)) {
    return { totalCost: 0, totalTokens: 0, byModel: [], byProject: [], byDay: [], since, generatedAt }
  }

  let projectSlugs: string[]
  try {
    projectSlugs = readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return { totalCost: 0, totalTokens: 0, byModel: [], byProject: [], byDay: [], since, generatedAt }
  }

  for (const slug of projectSlugs) {
    const dir = join(projectsDir, slug)
    let files: string[]
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const file of files) {
      const path = join(dir, file)
      // Skip files untouched before the cutoff entirely.
      if (cutoffMs > 0) {
        try { if (statSync(path).mtimeMs < cutoffMs) continue } catch { continue }
      }
      let raw: string
      try { raw = readFileSync(path, 'utf-8') } catch { continue }

      for (const line of raw.split('\n')) {
        if (!line) continue
        let obj: Record<string, unknown>
        try { obj = JSON.parse(line) } catch { continue }
        const msg = obj.message as Record<string, unknown> | undefined
        const usage = msg?.usage as Record<string, unknown> | undefined
        const model = msg?.model as string | undefined
        if (!usage || !model || model === '<synthetic>') continue

        const ts = typeof obj.timestamp === 'string' ? obj.timestamp : undefined
        if (cutoffMs > 0 && ts && new Date(ts).getTime() < cutoffMs) continue

        // Dedupe assistant messages that appear in both main + sidechain transcripts.
        const id = msg?.id as string | undefined
        if (id) {
          const key = `${id}:${(obj.requestId as string) || ''}`
          if (seen.has(key)) continue
          seen.add(key)
        }

        const input = (usage.input_tokens as number) || 0
        const output = (usage.output_tokens as number) || 0
        const cacheRead = (usage.cache_read_input_tokens as number) || 0
        const ccTotal = (usage.cache_creation_input_tokens as number) || 0
        const cc = usage.cache_creation as Record<string, unknown> | undefined
        const has = cc && (typeof cc.ephemeral_5m_input_tokens === 'number' || typeof cc.ephemeral_1h_input_tokens === 'number')
        const cache5m = has ? ((cc!.ephemeral_5m_input_tokens as number) || 0) : ccTotal
        const cache1h = has ? ((cc!.ephemeral_1h_input_tokens as number) || 0) : 0

        const cost = lineCost(model, input, output, cacheRead, cache5m, cache1h)
        const cacheWrite = cache5m + cache1h
        const tokens = input + output + cacheRead + cacheWrite

        totalCost += cost
        totalTokens += tokens

        const m = byModel.get(model) || emptyAcc()
        m.inputTokens += input; m.outputTokens += output; m.cacheWriteTokens += cacheWrite; m.cacheReadTokens += cacheRead; m.cost += cost; m.messages += 1
        byModel.set(model, m)

        const p = byProject.get(slug) || { ...emptyAcc(), slug }
        p.inputTokens += input; p.outputTokens += output; p.cacheWriteTokens += cacheWrite; p.cacheReadTokens += cacheRead; p.cost += cost; p.messages += 1
        byProject.set(slug, p)

        const day = (ts || generatedAt).slice(0, 10)
        const d = byDay.get(day) || emptyAcc()
        d.cost += cost; d.inputTokens += input; d.outputTokens += output; d.cacheWriteTokens += cacheWrite; d.cacheReadTokens += cacheRead; d.messages += 1
        byDay.set(day, d)
      }
    }
  }

  const modelList: ModelUsage[] = Array.from(byModel.entries())
    .map(([model, a]) => ({ model, ...a }))
    .sort((x, y) => y.cost - x.cost)

  const projectList: ProjectUsage[] = Array.from(byProject.values())
    .map((a) => ({ slug: a.slug, name: projectName(a.slug), cost: a.cost, messages: a.messages, tokens: a.inputTokens + a.outputTokens + a.cacheReadTokens + a.cacheWriteTokens }))
    .sort((x, y) => y.cost - x.cost)

  const dayList: DayUsage[] = Array.from(byDay.entries())
    .map(([date, a]) => ({ date, cost: a.cost, tokens: a.inputTokens + a.outputTokens + a.cacheReadTokens + a.cacheWriteTokens }))
    .sort((x, y) => x.date.localeCompare(y.date))

  return { totalCost, totalTokens, byModel: modelList, byProject: projectList, byDay: dayList, since, generatedAt }
}
