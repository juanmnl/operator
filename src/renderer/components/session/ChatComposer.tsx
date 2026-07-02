import { useLayoutEffect, useRef, useState } from 'react'
import type { AgentSession } from '../../../shared/types'

// Shared chat composer for the reading panels (DOM + canvas). Sends the typed prompt to
// the agent's pty as a bracketed paste + CR (the same channel as the Plan tab's "Send to
// agent"), so Claude receives it as one message and the transcript observer surfaces the
// user turn back into the panel (~1s). The terminal stays the agent's stdin — this is the
// hybrid input path, not a terminal replacement. `onSend` lets the host panel react (e.g.
// stick its scroll to the bottom for the new turn).
//
// Layout follows the modern chat-composer convention (ChatGPT / Claude desktop / Codex):
// a single rounded "pill" wraps the textarea, with a circular send control pinned inside
// its bottom-right corner. The textarea is borderless/transparent and AUTO-GROWS — the
// scrollbar only appears once it hits the max height (until then overflow is hidden, so a
// one-line box never shows a stray scrollbar). Colours follow the app's transparent-tint
// aesthetic (no solid accent fills, no browser focus ring).
const MAX_H = 140

export function ChatComposer({ session, onSend }: { session?: AgentSession; onSend?: () => void }) {
  const [draft, setDraft] = useState('')
  const [focused, setFocused] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const live = !!session?.terminalId
  const canSend = draft.trim().length > 0 && live

  // Auto-grow: reset to auto, match content height (capped), and only enable scrolling
  // once we're at the cap — so the box never shows a scrollbar while it still has room.
  useLayoutEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    const next = Math.min(el.scrollHeight, MAX_H)
    el.style.height = `${next}px`
    el.style.overflowY = el.scrollHeight > MAX_H ? 'auto' : 'hidden'
  }, [draft])

  const send = () => {
    if (!canSend || !session?.terminalId) return
    window.operator.terminalWrite(session.terminalId, `\x1b[200~${draft.trim()}\x1b[201~\r`)
    setDraft('')
    onSend?.()
  }

  return (
    <div style={{ flexShrink: 0, padding: '10px 12px', fontFamily: 'var(--font-body)' }}>
      <div style={{
        position: 'relative', display: 'flex', alignItems: 'flex-end',
        borderRadius: 14, background: 'var(--overlay-subtle)',
        border: `1px solid ${focused ? 'color-mix(in srgb, var(--accent) 45%, var(--border))' : 'var(--border)'}`,
        transition: 'border-color 120ms ease',
      }}>
        <textarea
          ref={taRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter inserts a newline.
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
          }}
          placeholder={live ? 'Message the agent…' : 'No live session'}
          rows={1}
          disabled={!live}
          style={{
            flex: 1, minWidth: 0, boxSizing: 'border-box', resize: 'none', overflowY: 'hidden',
            fontFamily: 'inherit', fontSize: 12.5, lineHeight: 1.45,
            background: 'transparent', color: 'var(--fg)', border: 'none', outline: 'none',
            padding: '9px 44px 9px 12px', margin: 0,
          }}
        />
        <button
          onClick={send}
          disabled={!canSend}
          title="Send to the agent (Enter)"
          style={{
            position: 'absolute', right: 6, bottom: 6,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 28, height: 28, padding: 0, borderRadius: '50%',
            cursor: canSend ? 'pointer' : 'default', outline: 'none',
            color: canSend ? 'var(--accent)' : 'var(--fg-muted)',
            border: `1px solid ${canSend ? 'color-mix(in srgb, var(--accent) 55%, transparent)' : 'var(--border)'}`,
            background: canSend ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent',
            opacity: live ? 1 : 0.5,
            transition: 'color 120ms ease, background 120ms ease, border-color 120ms ease',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M8 12.5V4M8 4L4.5 7.5M8 4l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  )
}
