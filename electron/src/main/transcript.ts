// THE TAILER — what makes Operator a live view rather than a terminal with a sidebar.
//
// Ported from `src-tauri/src/transcript.rs`. Claude Code writes a JSONL transcript per session
// at `~/.claude/projects/<slug>/<uuid>.jsonl`; this follows each registered session's file and
// turns appended lines into an `AgentSession` the renderer already knows how to draw. There is
// NO hook and no cooperation from Claude Code — the file is the whole interface, which is why
// the read has to be defensive at every step.
//
// The offset discipline is the load-bearing part. A partial trailing line is left unconsumed
// until its newline arrives (a JSON object split across two polls parses as garbage otherwise),
// and a file that SHRANK is treated as rotated and re-read from zero rather than seeked past
// its own end.
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { open, readdir, stat, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { operatorDir } from './store'
import { summarize, firstLine } from './tool-summary'
import { parseDispatches, parseReplies, directiveId } from './directives'
// The RENDERER'S types, not a parallel set. The whole premise of this port is that the seam is
// derived rather than restated, and that has to include the payload shapes: a session this
// module builds must satisfy the same `AgentSession` the UI destructures.
import type { AgentSession, NarrationEntry, ActivityEntry, TodoItem } from '../../../src/shared/types'

/** Narration entries retained per session in the LIVE payload. The durable history is the chat
 *  store's job; this is the tail the UI renders without a query. */
const NARRATION_CAP = 80
/** How much of a prompt is recorded before an ellipsis. Mirrored by TURN_TEXT_CAP in
 *  delivery-confirm.ts, which is what lets the frontend recognise its own truncated message. */
const PROMPT_TEXT_CAP = 4000
const QUEUED_CAP = 20
/** Capped here rather than at render time: a p90 tool_result is ~35KB and a few of those per
 *  session, held in every payload, is the difference between a snappy store and a heavy one. */
const TOOL_RESULT_CAP = 2000

export interface NewTrack { claudeSessionId: string; cwd: string; permissionMode?: string | null; projectId: string }


export interface DispatchEvent { id: string; sessionId: string; terminalId: string; role: string; task: string }
export interface ReplyEvent { id: string; sessionId: string; terminalId: string; projectId: string; to: string; text: string; ts: string }

const nowIso = () => new Date().toISOString()

/** Find a session's transcript. Claude Code slugifies the cwd into a directory name we do not
 *  reproduce — so rather than deriving the slug (a second implementation free to drift), scan
 *  the project dirs for the file named after the session uuid. */
async function findTranscript(sessionId: string): Promise<string | null> {
  const projects = join(homedir(), '.claude', 'projects')
  let entries
  try { entries = await readdir(projects, { withFileTypes: true }) } catch { return null }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const p = join(projects, e.name, `${sessionId}.jsonl`)
    try { if ((await stat(p)).isFile()) return p } catch { /* not this one */ }
  }
  return null
}

/** The session phase, from the three signals the tailer tracks. Pure so it can be tested
 *  without a Track. Called only while the pty is QUIET — that is what makes "waiting" mean
 *  "the turn ended and nobody is typing" rather than "nothing happened this instant". */
export function derivePhase(runningTools: boolean, lastStopReason: string | null, lastWasUserPrompt: boolean): string {
  if (runningTools) return 'running'
  if (lastStopReason === 'tool_use') return 'running'
  if (lastWasUserPrompt) return 'running' // prompt sent, response not started yet
  return 'waiting'
}

/** Turns Claude Code injects that are not the user speaking. Recording them as prompts made
 *  the session summary read as the injected preamble instead of the actual task. */
export function isInjectedTurn(text: string): boolean {
  const t = text.trimStart()
  return ['<local-command-', '<command-name>', '<command-message>', '<command-args>',
    '<system-reminder>', '<task-notification>', '<synthetic>'].some((p) => t.startsWith(p))
}

/** A tool result is either a string or an array of blocks. FLATTEN THE ARRAY TO ITS TEXT —
 *  stringifying it kept about a third of real results as raw JSON, so the transcript showed
 *  `[{"type":"text","text":"…"}]` where the output should be. */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' ? (b as Record<string, unknown>).text : undefined))
      .filter((t): t is string => typeof t === 'string')
      .join('\n')
  }
  if (content == null) return ''
  return JSON.stringify(content)
}

/** The user's actual prompt text, or null. An array containing a tool_result is a RESULT turn,
 *  not a prompt — Claude Code uses the same `user` type for both. */
export function userPromptText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  if (content.some((b) => b && typeof b === 'object' && (b as Record<string, unknown>).type === 'tool_result')) return null
  const out = content
    .filter((b) => b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text')
    .map((b) => (b as Record<string, unknown>).text)
    .filter((t): t is string => typeof t === 'string')
    .join('')
  return out.trim() ? out : null
}

/** Claude Code's task statuses are an open string in the transcript and a closed union in the
 *  renderer. Anything unrecognised lands as `pending` rather than widening the union — an
 *  unknown status rendering as "not started yet" is the harmless direction. */
const asTodoStatus = (v: unknown): TodoItem['status'] =>
  v === 'in_progress' || v === 'completed' ? v : 'pending'

const cap = (s: string, n: number): string => ([...s].length > n ? `${[...s].slice(0, n).join('')}…` : s)

class Track {
  file: string | null = null
  offset = 0
  ended = false
  dirty = false
  lastPhase = ''
  summary: string | null = null
  startedAt: string | null = null
  lastActivityAt = ''
  model: string | null = null
  usage = { input: 0, output: 0, cacheRead: 0 }
  lastUsageMsgId: string | null = null
  lastStopReason: string | null = null
  lastWasUserPrompt = false
  lastToolName: string | null = null
  openTools = new Set<string>()
  inSidechain = false
  activeSubagents = 0
  narration: NarrationEntry[] = []
  activity: ActivityEntry[] = []
  queued: NarrationEntry[] = []
  tasks: Array<[string, TodoItem]> = []
  taskN = 0
  pending: NarrationEntry[] = []
  pendingDispatches: DispatchEvent[] = []
  pendingReplies: ReplyEvent[] = []

  constructor(readonly terminalId: string, readonly track: NewTrack) {}

  get sessionId(): string { return this.track.claudeSessionId }

  phase(): string { return derivePhase(this.openTools.size > 0, this.lastStopReason, this.lastWasUserPrompt) }

  /** Drop everything DERIVED from the transcript, keeping the track's identity. Called when the
   *  file is re-read from the start, so the rebuilt state describes the file that exists now. */
  private resetForReread(): void {
    this.summary = null
    this.startedAt = null
    this.model = null
    this.usage = { input: 0, output: 0, cacheRead: 0 }
    this.lastUsageMsgId = null
    this.lastStopReason = null
    this.lastWasUserPrompt = false
    this.lastToolName = null
    this.openTools.clear()
    this.inSidechain = false
    this.activeSubagents = 0
    this.narration.length = 0
    this.activity.length = 0
    this.queued.length = 0
    this.tasks.length = 0
    this.taskN = 0
    // `pending*` are outbound queues, not derived state — anything already parsed and not yet
    // emitted still needs to go out, and the directive ids make a repeat harmless anyway.
  }

  private pushNarration(e: NarrationEntry): void {
    this.narration.push(e)
    if (this.narration.length > NARRATION_CAP) this.narration.splice(0, this.narration.length - NARRATION_CAP)
    this.pending.push(e)
    this.dirty = true
  }

  async poll(): Promise<void> {
    if (!this.file) this.file = await findTranscript(this.sessionId)
    if (!this.file) return
    let fh
    try { fh = await open(this.file, 'r') } catch { return }
    try {
      const { size } = await fh.stat()
      // A file that shrank was rotated or truncated: re-read from zero rather than seek past
      // its own end and then never see anything again.
      //
      // AND DISCARD WHAT WAS PARSED FROM THE OLD FILE. Resetting only the offset — which is
      // what the Rust does — re-applies every line of the new file ON TOP of the state derived
      // from the old one, so the session shows the truncated content twice and its token totals
      // are the sum of both. Latent there because transcripts do not normally shrink; caught
      // here by the rotation test, and cheaper to fix than to leave as a trap.
      if (size < this.offset) { this.offset = 0; this.resetForReread() }
      if (size === this.offset) return
      const length = size - this.offset
      const buf = Buffer.alloc(length)
      const { bytesRead } = await fh.read(buf, 0, length, this.offset)
      const text = buf.subarray(0, bytesRead).toString('utf8')

      let consumed = 0
      let processed = false
      for (const chunk of text.split(/(?<=\n)/)) {
        // A partial trailing line is LEFT UNCONSUMED. Claude Code appends a whole JSON object
        // per line but the write is not atomic, so half a line is normal — parsing it would
        // drop the turn and advancing past it would lose it for good.
        if (!chunk.endsWith('\n')) break
        consumed += Buffer.byteLength(chunk, 'utf8')
        const line = chunk.trimEnd()
        if (!line) continue
        try { this.apply(JSON.parse(line)); processed = true } catch { /* not JSON — skip the line, keep the offset */ }
      }
      this.offset += consumed
      if (processed) this.dirty = true
    } finally {
      await fh.close().catch(() => {})
    }
  }

  private apply(v: Record<string, unknown>): void {
    const ts = typeof v.timestamp === 'string' ? v.timestamp : ''
    if (ts) {
      if (!this.startedAt) this.startedAt = ts
      this.lastActivityAt = ts
    }
    // Sidechain = a subagent's turns, interleaved into the same file. The transition in and
    // out is the only signal that one started or finished.
    const isSide = v.isSidechain === true
    if (isSide && !this.inSidechain) {
      this.activity.push({ toolName: 'Subagent started', timestamp: ts, status: 'auto', kind: 'subagent', detail: 'running' })
      this.activeSubagents += 1
      this.inSidechain = true
      this.dirty = true
    } else if (!isSide && this.inSidechain) {
      this.activity.push({ toolName: 'Subagent finished', timestamp: ts, status: 'auto', kind: 'subagent' })
      this.activeSubagents = Math.max(0, this.activeSubagents - 1)
      this.inSidechain = false
      this.dirty = true
    }

    switch (v.type) {
      case 'user': this.applyUser(v); break
      case 'assistant': this.applyAssistant(v, ts); break
      case 'queue-operation': this.applyQueueOp(v, ts); break
      default: break
    }
  }

  /** A prompt typed into a mid-turn lane leaves ONLY this — never a `user` turn — which is why
   *  the delivery loop has to read it. Treating its absence as "undelivered" produced 52 false
   *  reports out of 62. */
  private applyQueueOp(v: Record<string, unknown>, ts: string): void {
    if (v.operation !== 'enqueue') return
    const text = v.content
    if (typeof text !== 'string' || !text.trim() || isInjectedTurn(text)) return
    this.queued.push({ kind: 'queued', text: cap(text, PROMPT_TEXT_CAP), timestamp: ts || nowIso(), images: [] })
    if (this.queued.length > QUEUED_CAP) this.queued.splice(0, this.queued.length - QUEUED_CAP)
    this.dirty = true
  }

  private applyUser(v: Record<string, unknown>): void {
    const message = v.message as Record<string, unknown> | undefined
    const content = message?.content

    if (Array.isArray(content)) {
      for (const b of content) {
        if (!b || typeof b !== 'object') continue
        const block = b as Record<string, unknown>
        if (block.type !== 'tool_result') continue
        const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : null
        if (!id) continue
        const raw = toolResultText(block.content)
        if (raw) {
          const chars = [...raw].length
          // Find the CALL this result belongs to and fill it in — the pair is what the chat
          // renders as one block.
          for (let i = this.narration.length - 1; i >= 0; i--) {
            const entry = this.narration[i]
            if (entry.tool?.id !== id) continue
            entry.tool.output = [...raw].slice(0, TOOL_RESULT_CAP).join('')
            entry.tool.outputChars = chars
            entry.tool.truncated = chars > TOOL_RESULT_CAP
            this.pending.push(entry)
            this.dirty = true
            break
          }
        }
        this.openTools.delete(id)
        if (this.openTools.size === 0) this.lastToolName = null
      }
    }

    if (v.isSidechain === true) return

    const text = userPromptText(content)
    if (text == null) return
    this.lastWasUserPrompt = true
    this.lastStopReason = null
    const injected = isInjectedTurn(text)
    // The summary is the FIRST real prompt. An injected turn must not claim it, or every
    // session is titled with Operator's own dev-server preamble.
    if (!this.summary && !injected) {
      const line = firstLine(text, 60)
      if (line) { this.summary = line; this.dirty = true }
    }
    if (injected) return
    this.pushNarration({
      kind: 'user',
      text: cap(text, PROMPT_TEXT_CAP),
      timestamp: typeof v.timestamp === 'string' ? v.timestamp : nowIso(),
      images: [],
    })
  }

  private applyAssistant(v: Record<string, unknown>, ts: string): void {
    this.lastWasUserPrompt = false
    const msg = v.message as Record<string, unknown> | undefined
    if (!msg) return
    this.lastStopReason = typeof msg.stop_reason === 'string' ? msg.stop_reason : null

    // A SUBAGENT'S model is not the lane's model. Reading it from a sidechain turn would show
    // the lane running whatever its last subagent used.
    if (v.isSidechain !== true && typeof msg.model === 'string' && msg.model && !msg.model.startsWith('<')) {
      this.model = msg.model
    }

    const usage = msg.usage as Record<string, unknown> | undefined
    if (usage) {
      const mid = typeof msg.id === 'string' ? msg.id : ''
      // Claude Code re-emits the same message id as a turn streams; counting each emission
      // would multiply the token totals.
      if (mid && this.lastUsageMsgId !== mid) {
        this.lastUsageMsgId = mid
        const g = (k: string) => (typeof usage[k] === 'number' ? (usage[k] as number) : 0)
        this.usage.input += g('input_tokens') + g('cache_creation_input_tokens')
        this.usage.output += g('output_tokens')
        this.usage.cacheRead += g('cache_read_input_tokens')
        this.dirty = true
      }
    }

    const blocks = msg.content
    if (!Array.isArray(blocks)) return

    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue
      const block = b as Record<string, unknown>
      const btype = typeof block.type === 'string' ? block.type : ''

      if (btype === 'text' || btype === 'thinking') {
        const s = block[btype === 'thinking' ? 'thinking' : 'text']
        if (typeof s !== 'string') continue
        // SENTINELS COME FROM `text` ONLY. A directive inside `thinking` is the model
        // considering one, not issuing it.
        if (btype === 'text') {
          for (const [role, task] of parseDispatches(s)) {
            this.pendingDispatches.push({ id: directiveId(this.sessionId, role, task), sessionId: this.sessionId, terminalId: this.terminalId, role, task })
            this.dirty = true
          }
          for (const [to, text] of parseReplies(s)) {
            this.pendingReplies.push({ id: directiveId(this.sessionId, to, text), sessionId: this.sessionId, terminalId: this.terminalId, projectId: this.track.projectId, to, text, ts })
            this.dirty = true
          }
        }
        if (s.trim()) this.pushNarration({ kind: btype as NarrationEntry['kind'], text: s, timestamp: ts, images: [] })
        continue
      }

      if (btype !== 'tool_use') continue
      const name = typeof block.name === 'string' ? block.name : 'Tool'
      const input = block.input ?? null
      const id = typeof block.id === 'string' ? block.id : undefined
      if (id) this.openTools.add(id)
      this.applyTaskTools(name, input)

      const s = summarize(name, input)
      this.lastToolName = name
      this.activity.push({ toolName: name, target: s.target, timestamp: ts, status: 'auto', kind: 'tool', detail: s.preview })
      this.pushNarration({
        kind: 'tool',
        text: '',
        timestamp: ts,
        images: [],
        tool: {
          name,
          target: s.target,
          caller: typeof v.userType === 'string' ? v.userType : undefined,
          output: '',
          outputChars: 0,
          truncated: false,
          id,
        },
      })
    }
  }

  /** TodoWrite / TaskCreate / TaskUpdate are the lane's own task list, which the plan panel
   *  renders. Kept as an ordered pair list rather than a map so a re-render preserves order. */
  private applyTaskTools(name: string, input: unknown): void {
    const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
    if (name === 'TodoWrite' && Array.isArray(inp.todos)) {
      this.tasks = inp.todos.flatMap((t, i) => {
        const todo = t as Record<string, unknown>
        return typeof todo?.content === 'string'
          ? [[String(i), { content: todo.content, status: asTodoStatus(todo.status) }] as [string, TodoItem]]
          : []
      })
      this.dirty = true
    } else if (name === 'TaskCreate' && typeof inp.subject === 'string') {
      this.taskN += 1
      this.tasks.push([String(this.taskN), { content: inp.subject, status: 'pending' }])
      this.dirty = true
    } else if (name === 'TaskUpdate' && typeof inp.taskId === 'string') {
      const status = typeof inp.status === 'string' ? inp.status : undefined
      if (status === 'deleted') {
        this.tasks = this.tasks.filter(([tid]) => tid !== inp.taskId)
      } else {
        const found = this.tasks.find(([tid]) => tid === inp.taskId)
        if (found) {
          if (status) found[1].status = asTodoStatus(status)
          if (typeof inp.subject === 'string') found[1].content = inp.subject
        }
      }
      this.dirty = true
    }
  }

  toSession(phase: string): AgentSession {
    return {
      id: this.sessionId,
      agentId: 'claude-code',
      projectName: basename(this.track.cwd) || this.track.cwd,
      workingDirectory: this.track.cwd,
      summary: this.summary ?? undefined,
      status: this.ended ? 'ended' : 'active',
      phase: phase as AgentSession['phase'],
      activity: this.activity.slice(-NARRATION_CAP),
      messages: this.narration,
      queued: this.queued,
      todos: this.tasks.map(([, t]) => t),
      activeSubagents: this.activeSubagents,
      lastToolName: this.lastToolName,
      startedAt: this.startedAt ?? nowIso(),
      lastActivityAt: this.lastActivityAt || nowIso(),
      terminalId: this.terminalId,
      permissionMode: this.track.permissionMode ?? undefined,
      model: this.model ?? undefined,
      usage: this.usage,
    }
  }
}

/** Registry + tailer. `terminalSpawn` registers; the loop reads.
 *
 *  Events are emitted rather than pushed straight at a window so the shell can decide where
 *  they go — and so this module stays testable without an Electron app. */
export class Transcript extends EventEmitter {
  private readonly tracks = new Map<string, Track>()
  private timer: NodeJS.Timeout | null = null

  register(terminalId: string, t: NewTrack): void {
    if (!this.tracks.has(terminalId)) this.tracks.set(terminalId, new Track(terminalId, t))
  }

  /** The durable identity of a live pty — its Claude session id and project. Reported through
   *  `terminalList` so a re-attached tab can be re-linked by something that outlives a renderer
   *  respawn; `terminalId` is a per-run counter and the renderer's own map dies with it. */
  identity(terminalId: string): { claudeSessionId: string; projectId: string } | null {
    const t = this.tracks.get(terminalId)
    return t ? { claudeSessionId: t.track.claudeSessionId, projectId: t.track.projectId } : null
  }

  sessions(): AgentSession[] {
    return [...this.tracks.values()].map((t) => t.toSession(t.lastPhase || t.phase()))
  }

  /** `isAlive` and `isActive` are injected rather than imported: the pty manager owns those
   *  facts, and passing them in keeps this module free of a dependency it would otherwise only
   *  need for two booleans (and untestable without one). */
  start(opts: { isAlive: (id: string) => boolean; isActive: (id: string) => boolean; intervalMs?: number }): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.tick(opts) }, opts.intervalMs ?? 1000)
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  async tick(opts: { isAlive: (id: string) => boolean; isActive: (id: string) => boolean }): Promise<void> {
    let anyDirty = false
    for (const t of this.tracks.values()) {
      if (t.ended) continue
      const alive = opts.isAlive(t.terminalId)
      await t.poll()

      if (t.pending.length) { this.emit('chat', t.sessionId, t.pending.slice()); t.pending.length = 0 }
      for (const d of t.pendingDispatches.splice(0)) this.emit('dispatch', d)
      for (const r of t.pendingReplies.splice(0)) this.emit('reply', r)

      if (!alive) { t.ended = true; t.dirty = true }

      // PTY ACTIVITY OUTRANKS THE TRANSCRIPT. Bytes are moving now; the transcript is written
      // after the fact, so deriving "waiting" from it while output streams would flicker every
      // lane between running and waiting once a second.
      const ptyActive = !t.ended && opts.isActive(t.terminalId)
      const phase = ptyActive ? 'running' : t.phase()
      if (t.dirty || t.lastPhase !== phase) {
        t.lastPhase = phase
        t.dirty = false
        anyDirty = true
      }
    }
    if (anyDirty) this.emit('sessions', this.sessions())
  }

  /** Live lanes, for the quit guard. Published from the SAME triple the sessions come from, and
   *  deliberately not read from a frontend store: the accident this guards left the webview
   *  navigated away with no React app at all, and a count from there is absent exactly when it
   *  is needed. */
  liveLanes(isAlive: (id: string) => boolean): Array<{ terminalId: string; project: string; projectId: string; phase: string; lastActivityAt: string }> {
    return [...this.tracks.values()].filter((t) => isAlive(t.terminalId)).map((t) => ({
      terminalId: t.terminalId,
      project: basename(t.track.cwd) || t.track.cwd,
      projectId: t.track.projectId,
      phase: t.lastPhase || t.phase(),
      lastActivityAt: t.lastActivityAt,
    }))
  }
}

/** Cache a pasted/dropped image under `~/.operator/img-cache/<hash>.<ext>`, deduplicated by
 *  content so the same screenshot pasted twice costs one file. */
export async function cacheImage(dataB64: string, ext: string): Promise<string> {
  const dir = join(operatorDir(), 'img-cache')
  await mkdir(dir, { recursive: true })
  const hash = createHash('sha256').update(dataB64).digest('hex').slice(0, 16)
  const path = join(dir, `${hash}.${ext.replace(/^\./, '')}`)
  try { await stat(path) } catch { await writeFile(path, Buffer.from(dataB64, 'base64')) }
  return path
}
