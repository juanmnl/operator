import { promises as fs, existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import type { Rule, RuleAction } from '../shared/types'

const RULES_FILE = join(homedir(), '.operator', 'rules.json')

/** Convert a glob (with `*` wildcards) to a case-insensitive anchored regex. */
function globToRegex(glob: string): RegExp {
  // Escape regex metachars, then turn \* into .*
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`, 'i')
}

/** Pull the field a rule pattern should match against for a given tool. */
function primaryField(toolName: string, input: Record<string, unknown> | undefined): string | undefined {
  const i = input || {}
  switch (toolName) {
    case 'Bash':
      return i.command as string
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return i.file_path as string
    case 'NotebookEdit':
      return (i.notebook_path as string) || (i.file_path as string)
    case 'WebFetch':
      return i.url as string
    case 'WebSearch':
      return i.query as string
    default:
      return (i.file_path as string) || (i.command as string) || (i.path as string) || (i.url as string)
  }
}

export interface RuleEvaluation {
  matched: Rule
  decision: RuleAction
}

class RulesManager {
  private rules: Rule[] = []
  private loaded = false

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    try {
      const raw = await fs.readFile(RULES_FILE, 'utf-8')
      this.rules = JSON.parse(raw) as Rule[]
    } catch {
      this.rules = []
    }
    this.loaded = true
  }

  private async persist(): Promise<void> {
    const dir = dirname(RULES_FILE)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    await fs.writeFile(RULES_FILE, JSON.stringify(this.rules, null, 2) + '\n', 'utf-8')
  }

  async list(): Promise<Rule[]> {
    await this.ensureLoaded()
    return [...this.rules]
  }

  async add(rule: Omit<Rule, 'id' | 'createdAt'>): Promise<Rule> {
    await this.ensureLoaded()
    // De-dupe: don't add an identical rule twice
    const existing = this.rules.find((r) =>
      r.tool === rule.tool && r.pattern === rule.pattern && r.action === rule.action,
    )
    if (existing) return existing
    const full: Rule = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...rule,
    }
    this.rules.push(full)
    await this.persist()
    return full
  }

  async remove(id: string): Promise<void> {
    await this.ensureLoaded()
    this.rules = this.rules.filter((r) => r.id !== id)
    await this.persist()
  }

  /**
   * Evaluate rules for an incoming tool use. Returns the first matching rule
   * (rule order is creation order — earliest match wins).
   *
   * NOTE: synchronous behavior — callers must `await ready()` first to ensure
   * rules are loaded. We load eagerly on first IPC call and cache.
   */
  evaluate(toolName: string | undefined, input: Record<string, unknown> | undefined): RuleEvaluation | null {
    if (!toolName || !this.loaded) return null
    const field = primaryField(toolName, input)
    for (const rule of this.rules) {
      if (rule.tool !== '*' && rule.tool !== toolName) continue
      if (rule.pattern) {
        if (!field) continue
        if (!globToRegex(rule.pattern).test(field)) continue
      }
      return { matched: rule, decision: rule.action }
    }
    return null
  }

  ready(): Promise<void> {
    return this.ensureLoaded()
  }
}

export const rules = new RulesManager()
