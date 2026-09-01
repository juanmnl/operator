import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode, ClipboardEvent as ReactClipboardEvent } from 'react'
import type { AgentSession, EffortLevel } from '../../../shared/types'
import { persistFiles, imageFilesFrom } from '../../lib/paste-image'
import { modelFamilyLabel as displayModel } from '../../lib/roster'
import { EFFORT_OPTIONS } from '../../lib/effort'
import { PopMenu } from '../PopMenu'
import { submitQueue } from '../../lib/submit-queue'
import { chatSignal } from '../../lib/chat-signal'
import { MEASURE_FORM } from '../settings/PageShell'
import { StatusWave } from '../sidebar/StatusWave'
import { interruptSession } from '../../lib/interrupt'

// The chat composer — the two-way input for the reading panel. It drives the SAME Claude
// Code session as the terminal (this is the hybrid path, not a terminal replacement): the
// typed prompt goes to the agent's pty as a bracketed paste + CR, so Claude receives one
// message and the transcript observer surfaces the turn back into the panel (~1s).
//
// Overhaul: beyond plain text it now carries the controls a modern chat composer has —
//   • Attachments  — drop / paste / pick images; each is copied to a temp path and appended
//     to the prompt so Claude Code shortens it to a native `[Image #N]` (same mechanism as
//     the terminal's drop handler). Chips preview them before send.
//   • Model        — switch the live model via Claude Code's `/model` slash command.
//   • Effort       — `/effort <level>` to this lane's pty (applies to the next turn).
//   • Slash menu   — one-tap common commands (/clear, /compact, /context, …) to the pty.
// Colours follow the app's transparent-tint aesthetic (no solid accent fills, no focus ring).

const MAX_H = 140
/** §2: the send/stop control is an ORB — big enough to read as a status, not just a button. */
const ORB = 32, ORB_WAVE = 17

const MODELS = [
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
  { id: 'fable', label: 'Fable' },
] as const

// Commands sent verbatim to the pty (a bare line + CR, NOT a bracketed paste — Claude Code
// only treats a typed line as a slash command). Kept to the safe, common, non-destructive-ish
// set; /clear is confirmed by Claude Code itself so an accidental tap isn't catastrophic.
const SLASH = [
  { cmd: '/context', label: 'Context', hint: 'Show token usage' },
  { cmd: '/compact', label: 'Compact', hint: 'Summarize & shrink context' },
  { cmd: '/clear', label: 'Clear', hint: 'Start a fresh context' },
  { cmd: '/resume', label: 'Resume', hint: 'Pick a past conversation' },
  { cmd: '/help', label: 'Help', hint: 'Claude Code commands' },
] as const

interface Attachment { name: string; path: string; url: string }

export function ChatComposer({ session, laneAccent, onSend, onHumanSend, onModelChange, onEffortChange }: {
  session?: AgentSession
  /** The lane's colour, so the composer's orb is the SAME orb as the sidebar's (§2). */
  laneAccent?: string
  onSend?: () => void
  /** A HUMAN just addressed this lane. Distinct from `onSend`, which is a view concern (scroll
   *  stick): this is the delivery-brake reset — a human message is the only thing that restores a
   *  lane's hop budget, and this composer is the app's main human→lane surface. Without it a lane
   *  stopped by the chain limit stays unable to SEND for the rest of the process, however much
   *  you talk to it here (`exhausted` has no timer; see lib/agent-delivery). */
  onHumanSend?: (roleId?: string) => void
  /** Persist a `/model` switch back onto the session so the pill survives a tab switch. */
  onModelChange?: (model: string) => void
  onEffortChange?: (effort: EffortLevel) => void
}) {
  const [draft, setDraft] = useState('')
  const [focused, setFocused] = useState(false)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  // Seeded from the session's launch config so the pills REFLECT the live lane, then track
  // the user's in-session changes (/model, effort writes).
  const [model, setModel] = useState<string | null>(session?.model ?? null)
  const [effort, setEffort] = useState<string | null>(session?.effortLevel ?? null)
  const [menu, setMenu] = useState<'model' | 'effort' | 'slash' | null>(null)
  // "Other…" in the model menu — a free-typed id for a tier Claude Code's CLI accepts before
  // Operator has a preset for it. The listed tiers never need this: Claude Code resolves
  // `opus`/`sonnet`/… to the current point release on its own.
  const [customModel, setCustomModel] = useState(false)
  const [customModelId, setCustomModelId] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const live = !!session?.terminalId
  // While the agent is working, the send action IS the stop action. The composer used to
  // disable only on session DEATH, so mid-run you got a normal send box and no way to stop —
  // the one moment you most want one. Interrupt is Claude Code's own ESC, never a kill.
  const signal = chatSignal(session)
  const busy = !!signal?.interruptible && live
  const canSend = (draft.trim().length > 0 || attachments.length > 0) && live

  // Reset transient state + re-seed the pills from the newly-active session.
  useEffect(() => {
    setDraft(''); setAttachments([]); setMenu(null)
    setModel(session?.model ?? null); setEffort(session?.effortLevel ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id])

  // Track the session's model as it changes: the first transcript report backfills an
  // account-default launch, and a later change (a /model typed in the terminal, synced into
  // the session upstream) updates the pill too. A pill pick round-trips through the same
  // session.model, so following it never fights the user's own choice.
  useEffect(() => {
    if (session?.model) setModel(session.model)
  }, [session?.model])

  // Whenever the model menu isn't the open one, drop the custom-id draft — covers every close
  // path (pick, outside click, pill toggle, session switch) in one place.
  useEffect(() => {
    if (menu !== 'model') { setCustomModel(false); setCustomModelId('') }
  }, [menu])

  // Revoke object URLs on unmount so previews don't leak.
  useEffect(() => () => { attachments.forEach((a) => URL.revokeObjectURL(a.url)) }, [attachments])

  // Close any open menu on an outside click.
  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setMenu(null) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menu])

  // Auto-grow the textarea; only show its scrollbar once it hits the cap.
  useLayoutEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_H)}px`
    el.style.overflowY = el.scrollHeight > MAX_H ? 'auto' : 'hidden'
  }, [draft])

  const attach = useCallback(async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith('image/'))
    if (images.length === 0) return
    const paths = await persistFiles(images, window.operator.savePastedImage)
    setAttachments((prev) => [
      ...prev,
      ...paths.map((path, i) => ({ name: images[i].name || 'image', path, url: URL.createObjectURL(images[i]) })),
    ])
  }, [])

  const removeAttachment = (path: string) =>
    setAttachments((prev) => {
      const gone = prev.find((a) => a.path === path)
      if (gone) URL.revokeObjectURL(gone.url)
      return prev.filter((a) => a.path !== path)
    })

  const send = () => {
    if (!canSend || !session?.terminalId) return
    // Text + attachment paths in one bracketed paste; the trailing CR (outside the paste)
    // submits it as a single message. Claude Code turns each image path into `[Image #N]`.
    const parts = [draft.trim(), ...attachments.map((a) => a.path)].filter(Boolean)
    // Via the submit queue: a fast double-send, or a dispatch landing on this same lane,
    // would otherwise merge into one composer draft (see lib/submit-queue).
    void submitQueue.submit(session.terminalId, parts.join(' '))
    onHumanSend?.(session.roleId)
    attachments.forEach((a) => URL.revokeObjectURL(a.url))
    setDraft(''); setAttachments([])
    onSend?.()
  }

  // A slash command is a bare typed line (no bracketed paste), so Claude Code runs it.
  const runSlash = (cmd: string) => {
    if (!session?.terminalId) return
    window.operator.terminalWrite(session.terminalId, `${cmd}\r`)
    setMenu(null)
    onSend?.()
  }

  const pickModel = (id: string) => {
    setModel(id)
    setMenu(null)
    if (session?.terminalId) window.operator.terminalWrite(session.terminalId, `/model ${id}\r`)
    onModelChange?.(id)
  }

  // A hand-typed id goes out exactly like a preset — `/model <id>` to the pty, and Claude
  // Code is the one that validates it (it reports an unknown id in the transcript).
  const submitCustomModel = () => {
    const id = customModelId.trim()
    if (id) pickModel(id)
  }

  // `/effort <level>` TO THIS LANE'S PTY, exactly like `/model` above — a bare line + CR, not a
  // bracketed paste (see SLASH). It used to write `~/.claude/settings.json` instead, which was
  // wrong twice over: that file is app-wide, so one lane's pill moved every lane's default, and a
  // settings change cannot reach a session that is already running anyway. The pill updates
  // optimistically because the pty has no reply to wait for.
  const pickEffort = (id: EffortLevel) => {
    setEffort(id)
    setMenu(null)
    if (session?.terminalId) window.operator.terminalWrite(session.terminalId, `/effort ${id}\r`)
    onEffortChange?.(id)
  }

  const onPaste = (e: ReactClipboardEvent) => {
    const images = imageFilesFrom(e.clipboardData)
    if (images.length) { e.preventDefault(); void attach(images) }
  }

  // Handles both the alias set (opus/sonnet/…) and a full transcript model id (claude-opus-…).
  const modelLabel = model ? displayModel(model) : undefined
  const effortLabel = EFFORT_OPTIONS.find((m) => m.id === effort)?.label

  return (
    <div
      ref={rootRef}
      // §1: the composer shares the transcript's measure and centre line — it used to span
      // the full panel under a capped column.
      style={{
        flexShrink: 0, padding: '10px 4px 12px', fontFamily: 'var(--font-body)', position: 'relative',
        width: '100%', maxWidth: MEASURE_FORM, margin: '0 auto', boxSizing: 'border-box',
      }}
      onDragOver={(e) => { if (imageFilesFrom(e.dataTransfer).length || e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; if (!dragOver) setDragOver(true) } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false) }}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); void attach(imageFilesFrom(e.dataTransfer)) }}
    >
      <input
        ref={fileRef} type="file" accept="image/*" multiple style={{ display: 'none' }}
        onChange={(e) => { void attach(Array.from(e.target.files ?? [])); e.target.value = '' }}
      />

      {/* Popover menus (open upward, above the composer). */}
      {menu === 'model' && (
        <PopMenu
          title="Model"
          onClose={() => setMenu(null)}
          items={[
            ...MODELS.map((m) => ({ key: m.id, label: m.label, active: m.id === model, onClick: () => pickModel(m.id) })),
            { key: 'custom', label: 'Other…', hint: 'Model id', keepOpen: true, onClick: () => setCustomModel(true) },
          ]}
          footer={customModel && (
            <CustomModelRow value={customModelId} onChange={setCustomModelId} onSubmit={submitCustomModel} />
          )}
        />
      )}
      {menu === 'effort' && <PopMenu title="Reasoning effort" onClose={() => setMenu(null)} items={EFFORT_OPTIONS.map((m) => ({ key: m.id, label: m.label, active: m.id === effort, onClick: () => pickEffort(m.id) }))} />}
      {menu === 'slash' && <PopMenu title="Commands" onClose={() => setMenu(null)} items={SLASH.map((c) => ({ key: c.cmd, label: c.label, hint: c.hint, onClick: () => runSlash(c.cmd) }))} />}

      <div style={{
        position: 'relative', display: 'flex', flexDirection: 'column',
        borderRadius: 14, background: 'var(--overlay-subtle)',
        border: `1px solid ${dragOver ? 'var(--accent)' : focused ? 'color-mix(in srgb, var(--accent) 45%, var(--border))' : 'var(--border)'}`,
        transition: 'border-color 120ms ease',
      }}>
        {/* Attachment chips. */}
        {attachments.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '8px 10px 0' }}>
            {attachments.map((a) => (
              <div key={a.path} title={a.name} style={{ position: 'relative', width: 44, height: 44, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)' }}>
                <img src={a.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                <button
                  onClick={() => removeAttachment(a.path)} title="Remove"
                  style={{ position: 'absolute', top: 2, right: 2, width: 15, height: 15, padding: 0, display: 'grid', placeItems: 'center', border: 'none', borderRadius: 4, background: 'rgba(0,0,0,0.6)', color: '#fff', cursor: 'pointer', outline: 'none', fontSize: 9, lineHeight: 1 }}
                >✕</button>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={taRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onPaste={onPaste}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          placeholder={live ? 'Message the agent…' : 'No live session'}
          rows={1}
          disabled={!live}
          style={{
            flex: 1, minWidth: 0, boxSizing: 'border-box', resize: 'none', overflowY: 'hidden',
            fontFamily: 'inherit', fontSize: 12.5, lineHeight: 1.45,
            background: 'transparent', color: 'var(--fg)', border: 'none', outline: 'none',
            padding: '9px 12px 4px', margin: 0,
          }}
        />

        {/* Controls row: attach / slash / model / effort on the left, send on the right. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '2px 6px 6px' }}>
          <IconBtn title="Attach images" onClick={() => fileRef.current?.click()} disabled={!live}><PaperclipIcon /></IconBtn>
          <IconBtn title="Commands" opensMenu onClick={() => setMenu(menu === 'slash' ? null : 'slash')} active={menu === 'slash'} disabled={!live}><SlashIcon /></IconBtn>
          <Pill label={modelLabel ?? 'Model'} muted={!modelLabel} active={menu === 'model'} opensMenu onClick={() => setMenu(menu === 'model' ? null : 'model')} disabled={!live} />
          {busy && draft.trim().length > 0 && (
            <span style={{
              marginLeft: 'auto', marginRight: 2, flexShrink: 0,
              fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--fg-muted)',
            }}>
              ↵ sends into this turn
            </span>
          )}
          <Pill label={effortLabel ? `Effort · ${effortLabel}` : 'Effort'} muted={!effortLabel} active={menu === 'effort'} opensMenu onClick={() => setMenu(menu === 'effort' ? null : 'effort')} disabled={!live} />
          {/* §2 — THE ORB IS THE CONTROL. "The orb tells the truth about the lane; the ring
              is the verb." The core is the same StatusWave the sidebar, roster and gallery
              use, carrying the LANE ACCENT and the state from chatSignal — it never becomes a
              send icon. What changes around it is a ring and a glyph, which is where the
              action lives:
                • idle/waiting + empty  → status light, NOT a button (no action to take)
                • idle/waiting + text   → accent ring + arrow → send
                • running/compacting    → error-tinted ring + square → stop
                • no live session       → grey, reduced, aria-disabled
              Stop reads from the square + the ring, never red ink (--color-error measures
              2.81:1 on 1984-light). Motion stays the busy signal — no second idiom here. */}
          <button
            onClick={busy ? () => interruptSession(session?.terminalId) : send}
            disabled={!busy && !canSend}
            aria-disabled={!busy && !canSend}
            data-composer-action={busy ? 'stop' : canSend ? 'send' : 'idle'}
            title={busy
              ? 'Stop (Esc) — the session keeps running'
              : canSend ? 'Send to the agent (Enter)' : undefined}
            aria-label={busy ? 'Stop' : canSend ? 'Send' : 'Agent status'}
            style={{
              marginLeft: 'auto', position: 'relative', flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: ORB, height: ORB, padding: 0, borderRadius: '50%',
              // A status light is not a button: no pointer, no hover promise, no action.
              cursor: busy || canSend ? 'pointer' : 'default', outline: 'none',
              background: 'transparent',
              border: `1px solid ${busy
                ? 'color-mix(in srgb, var(--color-error, #f85149) 55%, var(--border))'
                : canSend ? 'color-mix(in srgb, var(--accent) 55%, transparent)' : 'transparent'}`,
              opacity: live ? 1 : 0.45,
              transition: 'border-color 120ms ease, opacity 120ms ease',
            }}
          >
            <StatusWave
              status={live ? (signal?.kind === 'ended' ? 'ended' : signal?.kind ?? 'idle') : 'ended'}
              seed={session?.id ?? 'composer'}
              size={ORB_WAVE}
              accent={live ? laneAccent : undefined}
            />
            {/* The verb, overlaid on the lane's own state — present only when there IS one. */}
            {(busy || canSend) && (
              <span style={{
                position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
                color: busy ? 'var(--fg)' : 'var(--accent)', pointerEvents: 'none',
                // A halo so the glyph reads over the wave's dots, same trick as the rail.
                filter: 'drop-shadow(0 0 3px var(--bg-terminal)) drop-shadow(0 0 3px var(--bg-terminal))',
              }}>
                {busy ? (
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                    <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
                  </svg>
                ) : (
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                    <path d="M8 12.5V4M8 4L4.5 7.5M8 4l3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </span>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---- small building blocks -----------------------------------------------------------

function IconBtn({ children, title, onClick, active, disabled, opensMenu }: { children: ReactNode; title: string; onClick: () => void; active?: boolean; disabled?: boolean; opensMenu?: boolean }) {
  return (
    <button
      {...(opensMenu ? { 'data-popmenu-trigger': '' } : null)}
      onClick={onClick} title={title} disabled={disabled}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, padding: 0,
        borderRadius: 7, border: 'none', background: 'transparent', outline: 'none',
        cursor: disabled ? 'default' : 'pointer', 
        color: active ? 'var(--accent)' : 'var(--fg-muted)',
      }}
    >{children}</button>
  )
}

function Pill({ label, onClick, active, muted, disabled, opensMenu }: { label: string; onClick: () => void; active?: boolean; muted?: boolean; disabled?: boolean; opensMenu?: boolean }) {
  return (
    <button
      {...(opensMenu ? { 'data-popmenu-trigger': '' } : null)}
      onClick={onClick} disabled={disabled}
      style={{
        display: 'flex', alignItems: 'center', gap: 4, height: 24, padding: '0 8px',
        borderRadius: 7, border: '1px solid var(--border)', background: 'transparent', outline: 'none',
        cursor: disabled ? 'default' : 'pointer', 
        fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.03em',
        color: active ? 'var(--accent)' : muted ? 'var(--fg-muted)' : 'var(--fg)',
        borderColor: active ? 'color-mix(in srgb, var(--accent) 45%, var(--border))' : 'var(--border)',
      }}
    >
      {label}
      <svg width="8" height="8" viewBox="0 0 12 12" fill="none" style={{ opacity: 0.7 }}><path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
  )
}

/** Free-typed model id, revealed by the menu's "Other…" entry. Enter or ↵ sends it as
 *  `/model <id>`, so a tier the CLI already supports is usable without an Operator release. */
function CustomModelRow({ value, onChange, onSubmit }: { value: string; onChange: (v: string) => void; onSubmit: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px 9px', borderTop: '1px solid var(--border)' }}>
      <input
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        // Enter commits; the composer's own key handling must not see these keys.
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); onSubmit() } }}
        placeholder="model id or alias"
        style={{
          flex: 1, minWidth: 0, boxSizing: 'border-box', padding: '4px 7px',
          borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-terminal)',
          color: 'var(--fg)', outline: 'none', fontFamily: 'var(--font-mono)', fontSize: 11,
        }}
      />
      <button
        onClick={onSubmit}
        disabled={!value.trim()}
        title="Switch this session to the typed model"
        style={{
          flexShrink: 0, height: 24, padding: '0 9px', borderRadius: 6, outline: 'none',
          cursor: value.trim() ? 'pointer' : 'default', opacity: value.trim() ? 1 : 0.4,
          fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.03em',
          color: 'var(--accent)',
          border: '1px solid color-mix(in srgb, var(--accent) 45%, var(--border))',
          background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
        }}
      >Set</button>
    </div>
  )
}

const iconStyle: CSSProperties = { display: 'block' }
function PaperclipIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={iconStyle}>
      <path d="M21 11.5l-8.6 8.6a5 5 0 0 1-7-7l8.5-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.5a1.7 1.7 0 0 1-2.3-2.3l7.9-7.9" />
    </svg>
  )
}
function SlashIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={iconStyle}>
      <path d="M9 20l6-16" />
    </svg>
  )
}
