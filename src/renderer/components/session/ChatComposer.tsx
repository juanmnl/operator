import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode, ClipboardEvent as ReactClipboardEvent } from 'react'
import type { AgentSession } from '../../../shared/types'
import { persistFiles, imageFilesFrom } from '../../lib/paste-image'
import { modelFamilyLabel as displayModel } from '../../lib/roster'
import { submitQueue } from '../../lib/submit-queue'

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
//   • Effort       — write the reasoning effort to global settings (applies to new turns).
//   • Slash menu   — one-tap common commands (/clear, /compact, /context, …) to the pty.
// Colours follow the app's transparent-tint aesthetic (no solid accent fills, no focus ring).

const MAX_H = 140

const MODELS = [
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
  { id: 'fable', label: 'Fable' },
] as const

const EFFORTS = [
  { id: 'high', label: 'High' },
  { id: 'normal', label: 'Normal' },
  { id: 'low', label: 'Low' },
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

export function ChatComposer({ session, onSend, onModelChange, onEffortChange }: {
  session?: AgentSession
  onSend?: () => void
  /** Persist a `/model` switch back onto the session so the pill survives a tab switch. */
  onModelChange?: (model: string) => void
  onEffortChange?: (effort: 'high' | 'normal' | 'low') => void
}) {
  const [draft, setDraft] = useState('')
  const [focused, setFocused] = useState(false)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  // Seeded from the session's launch config so the pills REFLECT the live lane, then track
  // the user's in-session changes (/model, effort writes).
  const [model, setModel] = useState<string | null>(session?.model ?? null)
  const [effort, setEffort] = useState<string | null>(session?.effortLevel ?? null)
  const [menu, setMenu] = useState<'model' | 'effort' | 'slash' | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const live = !!session?.terminalId
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

  // Effort lives in global settings (Claude Code reads it there); applies to new turns.
  const pickEffort = async (id: string) => {
    setEffort(id)
    setMenu(null)
    onEffortChange?.(id as 'high' | 'normal' | 'low')
    const cwd = session?.workingDirectory
    if (!cwd) return
    try {
      const prefs = await window.operator.folderPrefsLoad(cwd)
      const globalFile = prefs.settingsFiles.find((f) => f.scope === 'global')
      if (globalFile) await window.operator.folderPrefsSaveSettings(globalFile.path, { effortLevel: id as 'high' | 'normal' | 'low' })
    } catch { /* settings unavailable */ }
  }

  const onPaste = (e: ReactClipboardEvent) => {
    const images = imageFilesFrom(e.clipboardData)
    if (images.length) { e.preventDefault(); void attach(images) }
  }

  // Handles both the alias set (opus/sonnet/…) and a full transcript model id (claude-opus-…).
  const modelLabel = model ? displayModel(model) : undefined
  const effortLabel = EFFORTS.find((m) => m.id === effort)?.label

  return (
    <div
      ref={rootRef}
      style={{ flexShrink: 0, padding: '10px 12px', fontFamily: 'var(--font-body)', position: 'relative' }}
      onDragOver={(e) => { if (imageFilesFrom(e.dataTransfer).length || e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; if (!dragOver) setDragOver(true) } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false) }}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); void attach(imageFilesFrom(e.dataTransfer)) }}
    >
      <input
        ref={fileRef} type="file" accept="image/*" multiple style={{ display: 'none' }}
        onChange={(e) => { void attach(Array.from(e.target.files ?? [])); e.target.value = '' }}
      />

      {/* Popover menus (open upward, above the composer). */}
      {menu === 'model' && <PopMenu title="Model" onClose={() => setMenu(null)} items={MODELS.map((m) => ({ key: m.id, label: m.label, active: m.id === model, onClick: () => pickModel(m.id) }))} />}
      {menu === 'effort' && <PopMenu title="Reasoning effort" onClose={() => setMenu(null)} items={EFFORTS.map((m) => ({ key: m.id, label: m.label, active: m.id === effort, onClick: () => pickEffort(m.id) }))} />}
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
          <IconBtn title="Commands" onClick={() => setMenu(menu === 'slash' ? null : 'slash')} active={menu === 'slash'} disabled={!live}><SlashIcon /></IconBtn>
          <Pill label={modelLabel ?? 'Model'} muted={!modelLabel} active={menu === 'model'} onClick={() => setMenu(menu === 'model' ? null : 'model')} disabled={!live} />
          <Pill label={effortLabel ? `Effort · ${effortLabel}` : 'Effort'} muted={!effortLabel} active={menu === 'effort'} onClick={() => setMenu(menu === 'effort' ? null : 'effort')} disabled={!live} />
          <button
            onClick={send}
            disabled={!canSend}
            title="Send to the agent (Enter)"
            style={{
              marginLeft: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center',
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
    </div>
  )
}

// ---- small building blocks -----------------------------------------------------------

function IconBtn({ children, title, onClick, active, disabled }: { children: ReactNode; title: string; onClick: () => void; active?: boolean; disabled?: boolean }) {
  return (
    <button
      onClick={onClick} title={title} disabled={disabled}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, padding: 0,
        borderRadius: 7, border: 'none', background: 'transparent', outline: 'none',
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.4 : 1,
        color: active ? 'var(--accent)' : 'var(--fg-muted)',
      }}
    >{children}</button>
  )
}

function Pill({ label, onClick, active, muted, disabled }: { label: string; onClick: () => void; active?: boolean; muted?: boolean; disabled?: boolean }) {
  return (
    <button
      onClick={onClick} disabled={disabled}
      style={{
        display: 'flex', alignItems: 'center', gap: 4, height: 24, padding: '0 8px',
        borderRadius: 7, border: '1px solid var(--border)', background: 'transparent', outline: 'none',
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.4 : 1,
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

function PopMenu({ title, items, onClose }: { title: string; items: { key: string; label: string; hint?: string; active?: boolean; onClick: () => void }[]; onClose: () => void }) {
  return (
    <div
      style={{
        position: 'absolute', left: 12, right: 12, bottom: 'calc(100% - 6px)', zIndex: 20,
        marginBottom: 6, maxWidth: 260,
        borderRadius: 10, border: '1px solid var(--border)', background: 'var(--overlay-medium)',
        backdropFilter: 'blur(8px)', boxShadow: '0 10px 32px rgba(0,0,0,0.35)', overflow: 'hidden',
        fontFamily: 'var(--font-body)',
      }}
    >
      <div style={{ fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--fg-muted)', padding: '8px 12px 4px', fontFamily: 'var(--font-mono)' }}>{title}</div>
      {items.map((it) => (
        <button
          key={it.key}
          onClick={() => { it.onClick(); if (!it.active) onClose?.() }}
          style={{
            display: 'flex', alignItems: 'baseline', gap: 8, width: '100%', textAlign: 'left',
            padding: '7px 12px', border: 'none', background: 'transparent', outline: 'none', cursor: 'pointer',
            color: it.active ? 'var(--accent)' : 'var(--fg)', fontFamily: 'inherit', fontSize: 12,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--overlay-subtle)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          <span style={{ flexShrink: 0 }}>{it.label}</span>
          {it.hint && <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--fg-muted)' }}>{it.hint}</span>}
          {it.active && <span style={{ marginLeft: 'auto', color: 'var(--accent)' }}>✓</span>}
        </button>
      ))}
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
