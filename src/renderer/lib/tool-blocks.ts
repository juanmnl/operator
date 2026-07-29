import type { NarrationEntry, ToolBlock } from '../../shared/types'

// Tool calls as transcript punctuation.
//
// The rule from the critique: at rest these read as punctuation BETWEEN prose, subordinate to
// the answer — never a wall of cards. Two things make that true: a one-line summary per call,
// and COALESCING consecutive same-kind calls into one line ("Read 7 files"), which is what
// makes a 200-turn session survivable rather than a scroll of identical rows.

/** A run of consecutive tool calls of the same kind, rendered as one line. */
export interface ToolRun {
  kind: 'toolrun'
  /** The tool name shared by the run. */
  name: string
  /** Every call in the run, in order — the expanded view lists them. */
  calls: ToolBlock[]
  /** Who made them, when they all agree; undefined when a run mixes callers. */
  caller?: string
  timestamp: string
}

/** Past-tense verb for a completed call — "Read 7 files", not "Read tool ×7". */
const VERB: Record<string, { one: string; many: (n: number) => string }> = {
  Read: { one: 'Read a file', many: (n) => `Read ${n} files` },
  Edit: { one: 'Edited a file', many: (n) => `Edited ${n} files` },
  MultiEdit: { one: 'Edited a file', many: (n) => `Edited ${n} files` },
  Write: { one: 'Wrote a file', many: (n) => `Wrote ${n} files` },
  Bash: { one: 'Ran a command', many: (n) => `Ran ${n} commands` },
  Grep: { one: 'Searched', many: (n) => `Searched ${n} times` },
  Glob: { one: 'Searched', many: (n) => `Searched ${n} times` },
  WebFetch: { one: 'Fetched a page', many: (n) => `Fetched ${n} pages` },
  Task: { one: 'Delegated to a subagent', many: (n) => `Delegated ${n} times` },
  TodoWrite: { one: 'Updated the plan', many: (n) => `Updated the plan ${n}×` },
}

export function runLabel(run: ToolRun): string {
  const v = VERB[run.name]
  const n = run.calls.length
  if (v) return n === 1 ? v.one : v.many(n)
  return n === 1 ? run.name : `${run.name} ×${n}`
}

/** The single call's target, when a run is one call and has one — "Read src/app.ts". */
export function runDetail(run: ToolRun): string | undefined {
  return run.calls.length === 1 ? run.calls[0].target : undefined
}

/** True when any call in the run kept a result worth opening. */
export function runHasOutput(run: ToolRun): boolean {
  return run.calls.some((c) => (c.output ?? '').length > 0)
}

/** Fold consecutive same-name tool entries into runs; everything else passes through. */
export function coalesceTools(entries: NarrationEntry[]): (NarrationEntry | ToolRun)[] {
  const out: (NarrationEntry | ToolRun)[] = []
  for (const e of entries) {
    if (e.kind !== 'tool' || !e.tool) { out.push(e); continue }
    const prev = out[out.length - 1]
    // Only fold calls that agree on BOTH the tool and who made it — a subagent's reads must
    // not silently merge into the lead's.
    if (prev && 'kind' in prev && prev.kind === 'toolrun' && prev.name === e.tool.name && prev.caller === e.tool.caller) {
      prev.calls.push(e.tool)
      continue
    }
    out.push({ kind: 'toolrun', name: e.tool.name, calls: [e.tool], caller: e.tool.caller, timestamp: e.timestamp })
  }
  return out
}
