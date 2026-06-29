import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AgentSession, NarrationEntry } from '../../../shared/types'

// A read-only reading panel: the agent's prose answers (transcript `text` blocks)
// rendered as markdown, one card per answer, so you can read the explanation
// while the terminal keeps working. Each answer can be SAVED (kept/starred) or
// DISMISSED (hidden); both persist in localStorage. Thinking blocks aren't shown
// (Claude Code stores them empty — only a signature is persisted).

const SAVED_KEY = 'operator.answers.saved'
const DISMISSED_KEY = 'operator.answers.dismissed'
const COLLAPSED_KEY = 'operator.answers.collapsed'

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
  const answers = useMemo(
    () => (session?.messages ?? []).filter((m) => m.kind === 'text'),
    [session?.messages],
  )
  const [saved, setSaved] = useState<Set<string>>(() => loadSet(SAVED_KEY))
  const [dismissed, setDismissed] = useState<Set<string>>(() => loadSet(DISMISSED_KEY))
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadSet(COLLAPSED_KEY))
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
  const toggleCollapsed = (k: string) =>
    setCollapsed((p) => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); persist(COLLAPSED_KEY, n); return n })

  const visible = answers.filter((m) => {
    const k = blockKey(m)
    if (dismissed.has(k)) return false
    if (savedOnly && !saved.has(k)) return false
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
        padding: '6px 12px', borderBottom: '1px solid var(--border)',
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
            const isSaved = saved.has(k)
            const isCollapsed = collapsed.has(k)
            return (
              <div key={k} className={`reading-answer${isSaved ? ' is-saved' : ''}${isCollapsed ? ' is-collapsed' : ''}`}>
                <div className="reading-answer-actions">
                  <button onClick={() => toggleCollapsed(k)} title={isCollapsed ? 'Expand' : 'Collapse'} className="always">
                    ▾
                  </button>
                  <button onClick={() => copy(k, m.text)} title={copiedKey === k ? 'Copied' : 'Copy'} className={copiedKey === k ? 'on' : ''}>
                    {copiedKey === k ? '✓' : '⧉'}
                  </button>
                  <button onClick={() => toggleSaved(k)} title={isSaved ? 'Unsave' : 'Save'} className={isSaved ? 'on' : ''}>
                    {isSaved ? '★' : '☆'}
                  </button>
                  <button onClick={() => dismiss(k)} title="Dismiss">✕</button>
                </div>
                {isCollapsed ? (
                  <button className="reading-answer-preview" onClick={() => toggleCollapsed(k)} title="Expand">
                    {previewLine(m.text)}
                  </button>
                ) : (
                  <>
                    <div className="reading-md">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
                    </div>
                    <div className="reading-answer-time">
                      {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
