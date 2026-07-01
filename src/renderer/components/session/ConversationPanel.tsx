import { memo, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AgentSession, NarrationEntry } from '../../../shared/types'

// A fenced code block with a language label + copy button. Inline code keeps the
// default <code> styling; only multi-line / language-tagged code gets the chrome.
function CodeBlock({ text, lang }: { text: string; lang?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => navigator.clipboard?.writeText(text)
    .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200) })
    .catch(() => { /* clipboard blocked */ })
  return (
    <div className="reading-code">
      <div className="reading-code-head">
        <span className="reading-code-lang">{lang || 'text'}</span>
        <button className="reading-code-copy" onClick={copy}>{copied ? '✓ Copied' : 'Copy'}</button>
      </div>
      <pre><code>{text}</code></pre>
    </div>
  )
}

const MD_COMPONENTS: Components = {
  // Override <pre> to a passthrough so CodeBlock owns the block wrapper (avoids a
  // <pre> nested inside our own).
  pre: ({ children }) => <>{children}</>,
  code({ node: _node, className, children, ...props }) {
    const text = String(children ?? '')
    const lang = /language-(\w+)/.exec(className || '')?.[1]
    const isBlock = (className?.includes('language-')) || text.includes('\n')
    if (!isBlock) return <code className={className} {...props}>{children}</code>
    return <CodeBlock text={text.replace(/\n$/, '')} lang={lang} />
  },
}

// react-markdown re-parses its input on EVERY render, and remark-gfm's table/list
// grammar is super-linear — a large GFM table parses in SECONDS (an 80KB table ≈ 21s
// in-repo benchmark; a 500-deep nested list ≈ 1.7s). ConversationPanel re-renders on
// every `session:update` (~1/s), so an unbounded answer re-parsed forever pegs the
// WebContent process at 100% and freezes the app whenever the reading panel is open.
// Two guards: (1) memo so a SETTLED answer (stable text) parses once, not per render;
// (2) answers past a size cap render as plain preformatted text (instant) instead of
// running the markdown parser at all — bounding the pathological single parse too.
const MAX_MARKDOWN_CHARS = 16000
const MarkdownAnswer = memo(function MarkdownAnswer({ text }: { text: string }) {
  if (text.length > MAX_MARKDOWN_CHARS) {
    return <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, font: 'inherit' }}>{text}</pre>
  }
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{text}</ReactMarkdown>
})

// A read-only reading panel: the agent's prose answers (transcript `text` blocks)
// rendered as markdown, one card per answer, so you can read the explanation
// while the terminal keeps working. Each answer can be SAVED (kept/starred) or
// DISMISSED (hidden); both persist in localStorage. Thinking blocks aren't shown
// (Claude Code stores them empty — only a signature is persisted).

const SAVED_KEY = 'operator.answers.saved'
const DISMISSED_KEY = 'operator.answers.dismissed'
/** First non-empty line of an answer, lightly de-marked, for the collapsed preview. */
function previewLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? ''
  return line.replace(/^#+\s*/, '').replace(/[*_`>]/g, '').trim().slice(0, 90)
}

function loadSet(k: string): Set<string> {
  try { const r = localStorage.getItem(k); return new Set<string>(r ? JSON.parse(r) : []) } catch { return new Set() }
}
function persist(k: string, s: Set<string>) {
  try { localStorage.setItem(k, JSON.stringify([...s])) } catch { /* quota */ }
}
// Stable-ish identity for an answer block across re-emits (the backend re-sends
// the recent tail each update): timestamp + length + head of the text.
function blockKey(m: NarrationEntry): string {
  return `${m.timestamp}|${m.text.length}|${m.text.slice(0, 40)}`
}

export function ConversationPanel({ session }: { session?: AgentSession }) {
  // Durable chat history from the SQLite store (~/.operator/chat.db) — the WHOLE
  // conversation, loaded on session open. session:update only carries a bounded tail
  // (NARRATION_CAP) that's re-derived from the transcript, so without this the panel
  // could only ever show the last N answers and lost everything on restart.
  const [history, setHistory] = useState<NarrationEntry[]>([])
  useEffect(() => {
    const id = session?.id
    setHistory([]) // reset when switching sessions (only fires on id change)
    if (!id) return
    let cancelled = false
    // Only replace state when the store actually grew — answers are append-only, so a
    // longer result means new entries. Equal length ⇒ no change ⇒ keep the same array
    // ref so React (and the memoized markdown) don't re-render/re-parse.
    const load = () => window.operator.chatHistory?.(id)
      .then((h) => { if (!cancelled && h && h.length) setHistory((prev) => (h.length > prev.length ? h : prev)) })
      .catch(() => { /* store unavailable — fall back to the live tail below */ })
    load()
    // Periodic refresh: the live session:update tail only carries the most recent
    // NARRATION_CAP entries, so a long-running session that adds more than that
    // between session switches would otherwise leave a gap in the middle. Re-poll the
    // durable store to backfill. Ended sessions just return the same rows (a cheap
    // no-op SELECT), so no need to special-case them.
    const iv = window.setInterval(load, 15000)
    return () => { cancelled = true; clearInterval(iv) }
  }, [session?.id])

  // The conversation = human prompts (kind 'user') interleaved with the agent's
  // answers (kind 'text'), in transcript order — so it reads as a chat, not a
  // one-sided log. (Thinking blocks are excluded — Claude Code stores them empty.)
  // Merge durable history with the live tail: history is the full ordered record;
  // session.messages carries the freshest entries that may not be persisted yet
  // (~1s lag). Dedupe by blockKey (history wins), so each answer appears once.
  const turns = useMemo(() => {
    const seen = new Set<string>()
    const out: NarrationEntry[] = []
    for (const m of [...history, ...(session?.messages ?? [])]) {
      if (m.kind !== 'user' && m.kind !== 'text') continue
      const k = blockKey(m)
      if (seen.has(k)) continue
      seen.add(k)
      out.push(m)
    }
    return out
  }, [history, session?.messages])
  const [saved, setSaved] = useState<Set<string>>(() => loadSet(SAVED_KEY))
  const [dismissed, setDismissed] = useState<Set<string>>(() => loadSet(DISMISSED_KEY))
  // Answers are collapsed to a preview by default (you read the discussion, then
  // expand a whole answer on demand). `expanded` tracks the open ones — ephemeral
  // reading state, so it isn't persisted; each session opens condensed.
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [savedOnly, setSavedOnly] = useState(false)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  const copy = (k: string, text: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopiedKey(k)
      setTimeout(() => setCopiedKey((c) => (c === k ? null : c)), 1200)
    }).catch(() => { /* clipboard blocked */ })
  }
  const toggleSaved = (k: string) =>
    setSaved((p) => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); persist(SAVED_KEY, n); return n })
  const dismiss = (k: string) =>
    setDismissed((p) => { const n = new Set(p); n.add(k); persist(DISMISSED_KEY, n); return n })
  const toggleExpanded = (k: string) =>
    setExpanded((p) => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n })

  const visible = turns.filter((m) => {
    const k = blockKey(m)
    if (m.kind === 'text' && dismissed.has(k)) return false
    // Saved filter applies to answers only; in that mode the user turns drop out.
    if (savedOnly) return m.kind === 'text' && saved.has(k)
    return true
  })

  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const onScroll = () => {
    const el = scrollRef.current
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickRef.current && !savedOnly) el.scrollTop = el.scrollHeight
  }, [visible.length, session?.lastActivityAt, savedOnly])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0, background: 'var(--bg-terminal)' }}>
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8,
        height: 30, padding: '0 12px', boxSizing: 'border-box', borderBottom: '1px solid var(--border)',
        fontFamily: "'Inter', system-ui, sans-serif",
      }}>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button
            onClick={() => setSavedOnly((v) => !v)}
            title={savedOnly ? 'Show all answers' : 'Show saved only'}
            style={{
              fontSize: 10, fontFamily: 'inherit', cursor: 'pointer', outline: 'none',
              padding: '2px 8px', borderRadius: 6,
              border: '1px solid var(--border)',
              color: savedOnly ? 'var(--accent)' : 'var(--fg-muted)',
              background: 'transparent',
            }}
          >
            ★ {saved.size}
          </button>
        </span>
      </div>
      <div ref={scrollRef} onScroll={onScroll} className="scroll-hidden" style={{ flex: 1, overflow: 'auto', padding: '12px 12px 24px' }}>
        {visible.length === 0 ? (
          <div style={{ fontFamily: "'Inter', system-ui, sans-serif", fontSize: 12, color: 'var(--fg-muted)', opacity: 0.7, padding: '4px 4px' }}>
            {savedOnly ? 'No saved answers yet — star one to keep it here.' : 'The agent’s answers will appear here as it responds.'}
          </div>
        ) : (
          visible.map((m) => {
            const k = blockKey(m)
            const time = new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            // Human prompt — a "sent" bubble on the right.
            if (m.kind === 'user') {
              return (
                <div key={k} className="imsg-row is-user">
                  <div className="imsg-bubble is-user" title={m.text}>
                    <span className="imsg-user-text">{m.text}</span>
                    <div className="imsg-time">{time}</div>
                  </div>
                </div>
              )
            }
            // Agent answer — a "received" bubble on the left. Collapsed to a preview
            // line by default; tap to expand the full markdown answer in place.
            const isSaved = saved.has(k)
            const isExpanded = expanded.has(k)
            return (
              <div key={k} className="imsg-row is-agent">
                <div className={`imsg-bubble is-agent${isSaved ? ' is-saved' : ''}`}>
                  {!isExpanded ? (
                    <button className="imsg-preview" onClick={() => toggleExpanded(k)} title="Expand answer">
                      {previewLine(m.text)}<span className="imsg-more">more</span>
                    </button>
                  ) : (
                    <>
                      <div className="reading-md">
                        <MarkdownAnswer text={m.text} />
                      </div>
                      <div className="imsg-foot">
                        <button className="imsg-collapse" onClick={() => toggleExpanded(k)}>less</button>
                        <span className="imsg-time">{time}</span>
                      </div>
                    </>
                  )}
                  <div className="imsg-actions">
                    <button onClick={() => copy(k, m.text)} title={copiedKey === k ? 'Copied' : 'Copy'} className={copiedKey === k ? 'on' : ''}>
                      {copiedKey === k ? '✓' : '⧉'}
                    </button>
                    <button onClick={() => toggleSaved(k)} title={isSaved ? 'Unsave' : 'Save'} className={isSaved ? 'on' : ''}>
                      {isSaved ? '★' : '☆'}
                    </button>
                    <button onClick={() => dismiss(k)} title="Dismiss">✕</button>
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
