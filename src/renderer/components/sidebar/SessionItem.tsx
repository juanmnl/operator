import { useState, useRef, useEffect } from 'react'
import { useHoverCard } from '../../lib/use-hover-card'
import { AgentSession } from '../../../shared/types'
import { StatusWave } from './StatusWave'
import { sessionWaveStatus } from '../../lib/session-status'
import { laneTextColor } from '../../lib/lane-color'

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
  /** What this lane is working on now (or last did) — shown on hover, same as the
   *  collapsed rail, so the info doesn't disappear when the sidebar is expanded. */
  currentTask?: string
  closable: boolean
  /** 1-based Cmd+N hint for the first nine local sessions. */
  shortcutIndex?: number | null
  onClick: () => void
  onRename: (newName: string) => void
  onClose: () => void
  /** Right-click on the status dot → open the colour picker anchored under it. */
  onPickAccent?: (anchor: { top: number; left: number }) => void
}

export function SessionItem({ session, label, active, effortLevel, labelIsRole, roleColor, fanInfo, currentTask, closable, shortcutIndex, onClick, onRename, onClose, onPickAccent }: SessionItemProps) {
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(label)
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
  // The status logo animates ONLY for busy work now (running/compacting), so the phase WORD
  // carries the states the motionless logo can't: a QUIET "your turn" for waiting (its orb no
  // longer pulses), plus muted active-work words and red for error. Idle alone shows no word —
  // a resting orb needs no label. Keeping the words muted avoids the loud "YOUR TURN" of old.
  const isRunning = status === 'running'
  const showPhase = status === 'running' || status === 'compacting' || status === 'waiting' || status === 'error'
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

  // Shared with SidebarRail (lib/use-hover-card): row-moves-under-cursor AND
  // cursor-leaves-the-window, plus the one-card-app-wide guarantee.
  const hover = useHoverCard(session.id)
  const { card, hovered } = hover
  const endHover = () => { hover.dismiss(); setConfirmingClose(false) }

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
      ref={hover.ref as React.RefObject<HTMLDivElement>}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        setEditValue(label)
        setEditing(true)
      }}
      onMouseEnter={hover.onMouseEnter}
      onMouseLeave={endHover}
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
      <span
        data-accent-orb={session.id}
        onContextMenu={onPickAccent && ((e) => {
          // Right-click the orb to recolour; left-click falls through to row select.
          e.preventDefault()
          e.stopPropagation()
          const r = e.currentTarget.getBoundingClientRect()
          onPickAccent({ top: r.bottom + 6, left: r.left })
        })}
        style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}
      >
        <StatusWave status={status} seed={session.id} accent={roleColor} />
      </span>
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
              <span style={{
                // The lane name reads in its accent ONLY when this session is the
                // selected/focused row; otherwise it takes the same neutral ink as a
                // regular session title, so an unselected lane doesn't shout its colour
                // down the rail. "Which lane" still lives in the orb at rest (StatusWave
                // now carries a dimmed lane tint). Weight/tracking are unchanged.
                color: active
                  ? laneTextColor(roleColor)
                  : (isRunning ? 'var(--fg)' : 'color-mix(in srgb, var(--fg) 80%, transparent)'),
                textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600,
              }}>
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
            flexShrink: 0,
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
            
          }}
        >
          {confirmingClose ? '×?' : '×'}
        </button>
      )}
      </div>
      {/* Hover card — the lane's current/last task. Suppressed while renaming (the input
          owns the row) and when there's nothing to say. */}
      {card && currentTask && !editing && (
        <div style={{
          position: 'fixed', top: card.top, left: card.left, zIndex: 60, maxWidth: 260,
          padding: '7px 10px', borderRadius: 'var(--radius-sm)', background: 'var(--bg-surface)',
          boxShadow: '0 4px 16px rgba(0,0,0,0.35), inset 0 0 0 1px color-mix(in srgb, var(--fg) 12%, transparent)',
          pointerEvents: 'none', fontFamily: 'var(--font-mono)', lineHeight: 1.35,
        }}>
          <div style={{
            fontSize: 10.5, color: 'var(--fg-muted)',
            display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>
            {currentTask}
          </div>
        </div>
      )}
    </div>
  )
}
