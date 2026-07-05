import { useState, useRef, useEffect } from 'react'
import { AgentSession } from '../../../shared/types'
import { StatusWave } from './StatusWave'
import { sessionWaveStatus } from '../../lib/session-status'

interface SessionItemProps {
  session: AgentSession
  label: string
  active: boolean
  effortLevel?: string | null
  /** When the default label IS the role name (an orchestration lane, no custom name), render it
   *  in the role's colour + the tracked-uppercase "running / your turn" treatment. */
  labelIsRole?: boolean
  roleColor?: string
  /** Fan-out membership: this agent's position within a parallel launch. */
  fanInfo?: { index: number; total: number }
  closable: boolean
  /** 1-based Cmd+N hint for the first nine local sessions. */
  shortcutIndex?: number | null
  onClick: () => void
  onRename: (newName: string) => void
  onClose: () => void
}

export function SessionItem({ session, label, active, effortLevel, labelIsRole, roleColor, fanInfo, closable, shortcutIndex, onClick, onRename, onClose }: SessionItemProps) {
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(label)
  const [hovered, setHovered] = useState(false)
  const [confirmingClose, setConfirmingClose] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const status = sessionWaveStatus(session)

  // Landing-style uppercase phase word shown on the right of each row (rendered
  // uppercase via CSS). Mirrors the `.sess-phase` label in ../Operator-landing.
  const PHASE_LABEL: Record<string, string> = {
    running: 'running', compacting: 'compacting', waiting: 'your turn',
    idle: 'idle', ended: 'ended', error: 'error',
  }
  const phaseLabel = PHASE_LABEL[status] ?? status
  // The animated status logo (StatusWave) already signals busy / your-turn / idle, so the
  // phase WORD is redundant for those — and a bright-green "YOUR TURN" on every waiting row
  // was loud. Keep a QUIET word only where the logo can't disambiguate: muted for active work
  // (running/compacting), red for error. Waiting + idle show no word — the logo carries them.
  const isRunning = status === 'running'
  const showPhase = status === 'running' || status === 'compacting' || status === 'error'
  const phaseColor = status === 'error' ? 'var(--color-error, #f85149)' : 'var(--fg-muted)'

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  useEffect(() => () => {
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
  }, [])

  const commitRename = () => {
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== label) {
      onRename(trimmed)
    } else {
      setEditValue(label)
    }
    setEditing(false)
  }

  const handleCloseClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (confirmingClose) {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
      setConfirmingClose(false)
      onClose()
      return
    }
    setConfirmingClose(true)
    confirmTimerRef.current = setTimeout(() => setConfirmingClose(false), 2500)
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        setEditValue(label)
        setEditing(true)
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setConfirmingClose(false) }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        // Fixed height (not padding-driven) so every row is identical regardless of
        // its content — tool suffix, badges, shortcut hint all sit within the same box.
        height: 32,
        // The SELECTED (open) session must clearly dominate: a solid surface fill + a subtle
        // NEUTRAL inset ring (not an accent stripe — see the global no-left-marker rule), so it
        // reads as a distinct card, unmistakable next to a merely-RUNNING row (faint accent
        // wash). Running is a secondary tint; selected always wins.
        padding: '0 12px 0 8px',
        borderLeft: '2px solid transparent',
        background: active
          ? 'var(--bg-surface)'
          : isRunning ? 'color-mix(in srgb, var(--accent) 6%, transparent)' : 'transparent',
        boxShadow: active ? 'inset 0 0 0 1px color-mix(in srgb, var(--fg) 16%, transparent)' : 'none',
        borderTop: 'none', borderRight: 'none', borderBottom: 'none',
        borderRadius: active ? 6 : 0,
        cursor: 'pointer',
        textAlign: 'left',
        // Mono, matching the landing's session panel rows.
        fontFamily: 'var(--font-mono)',
        color: 'var(--fg)',
        fontSize: 11.5,
        // Tight line-box so the text centres exactly in the fixed 32px row — an inherited
        // tall line-height leaves descent space below the glyph, reading as "sits high".
        lineHeight: 1,
        boxSizing: 'border-box',
        outline: 'none',
      }}
    >
      <StatusWave status={status} seed={session.id} />
      {/* Left group: the session name with its lane badge sitting immediately after it, so the
          lane reads as part of the session — not a tag floating in the right cluster. */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
      <span
        style={{
          // Size to the name so the lane badge hugs it; grow only while editing (wide input).
          flex: editing ? 1 : '0 1 auto',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0,
        }}
      >
        {editing ? (
          <input
            ref={inputRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') { setEditValue(label); setEditing(false) }
              e.stopPropagation()
            }}
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'transparent',
              color: 'var(--fg)',
              border: '1px solid var(--border)',
              borderRadius: 3,
              fontSize: 12,
              fontFamily: 'inherit',
              padding: '0 4px',
              width: '100%',
              outline: 'none',
            }}
          />
        ) : (
          <>
            {/* A role-named session (orchestration lane) reads as the role: the role's colour +
                the tracked-uppercase treatment shared with the phase words. A plain session name
                reads full-strength when running, a touch dimmer when quiet. */}
            {labelIsRole ? (
              <span style={{ color: roleColor || 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600 }}>
                {label}
              </span>
            ) : (
              <span style={{ color: (isRunning || active) ? 'var(--fg)' : 'color-mix(in srgb, var(--fg) 80%, transparent)' }}>
                {label}
              </span>
            )}
          </>
        )}
      </span>
      </div>
      {/* Right group: status word + meta, right-aligned; yields to the close button on hover. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
      {!editing && fanInfo && (
        <span
          title={`Agent ${fanInfo.index} of ${fanInfo.total} in a parallel fan-out`}
          style={{
            fontSize: 8,
            fontWeight: 600,
            color: 'var(--accent)',
            background: 'var(--overlay-subtle)',
            borderRadius: 8,
            padding: '1px 5px',
            flexShrink: 0,
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: 0.2,
          }}
        >
          ⑂{fanInfo.index}/{fanInfo.total}
        </span>
      )}
      {!editing && session.activeSubagents > 0 && (
        <span
          title={`${session.activeSubagents} active subagent${session.activeSubagents > 1 ? 's' : ''}`}
          style={{
            fontSize: 10,
            color: 'var(--accent)',
            flexShrink: 0,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          ⤷{session.activeSubagents}
        </span>
      )}
      {/* Quiet phase word — only for active work / error (see showPhase above); waiting +
          idle rely on the animated logo. Hidden on hover so the close affordance can take
          its place (same gate as effort/shortcut). */}
      {!editing && showPhase && !(hovered && closable) && (
        <span
          style={{
            flexShrink: 0,
            fontSize: 9.5,
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            color: phaseColor,
            opacity: status === 'error' ? 0.95 : 0.65,
          }}
        >
          {phaseLabel}
        </span>
      )}
      {/* Effort only when it DEVIATES from the default (high) — an "H" on every row was noise;
          a lone "N"/"L" flags the exception worth noticing. Also in the composer + roster. */}
      {!editing && effortLevel && effortLevel !== 'high' && !(hovered && closable) && (
        <span
          title={`Effort: ${effortLevel}`}
          style={{
            fontSize: 8,
            fontWeight: 600,
            color: 'var(--fg-muted)',
            opacity: 0.5,
            flexShrink: 0,
            textTransform: 'uppercase',
          }}
        >
          {effortLevel[0]}
        </span>
      )}
      {!editing && shortcutIndex != null && !(hovered && closable) && (
        <span
          style={{
            fontSize: 9, color: 'var(--fg-muted)',
            opacity: 0.4, flexShrink: 0,
            fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace",
          }}
          title={`Switch with ⌘${shortcutIndex}`}
        >
          ⌘{shortcutIndex}
        </span>
      )}
      {!editing && closable && (hovered || confirmingClose) && (
        <button
          onClick={handleCloseClick}
          title={confirmingClose ? 'Click again to confirm' : 'Close session'}
          style={{
            background: confirmingClose ? 'var(--color-error)' : 'transparent',
            color: confirmingClose ? 'var(--fg-on-accent)' : 'var(--fg-muted)',
            border: 'none',
            borderRadius: 3,
            padding: '0 5px',
            fontSize: 10,
            fontFamily: 'inherit',
            lineHeight: '14px',
            cursor: 'pointer',
            flexShrink: 0,
            opacity: confirmingClose ? 1 : 0.5,
          }}
        >
          {confirmingClose ? '×?' : '×'}
        </button>
      )}
      </div>
    </div>
  )
}
