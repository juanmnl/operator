import { useEffect, useRef } from 'react'
import { overlayKey } from '../../lib/idle-suspend'

/** Over a lane suspended while idle (lib/idle-suspend): its last frame, dimmed, and one quiet line.
 *  A click or a typed key resumes it. Focus usually has already, so this mostly reads "Resuming…";
 *  it says "click to resume" after a resume that failed.
 *
 *  WHAT IS TYPED HERE IS KEPT (review L4). The keys were swallowed, so a person who typed into a
 *  lane that had just suspended lost the line. They are held, Backspace included, through
 *  "Resuming…", and handed to `onResume` after each pause in typing; the view types the last text it
 *  was handed into the resumed lane's composer, unsent.
 *
 *  AND HANDED OVER WHEN IT GOES (review N3). The resume that focus started usually finishes while
 *  the person is still typing, and that unmounts this overlay. Keys typed since the last pause were
 *  dropped with the pending timer; they are handed over from the unmount instead. */
export function SuspendedOverlay({ active, resuming, onResume }: { active: boolean; resuming: boolean; onResume: (held: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  // Takes the keyboard while it is the lane on screen, so typing reaches it instead of nothing.
  useEffect(() => { if (active) ref.current?.focus() }, [active])
  const held = useRef('')
  const fire = useRef<number | null>(null)
  // The latest handler, for the unmount below, which would otherwise call the first render's.
  const onResumeRef = useRef(onResume)
  onResumeRef.current = onResume
  // One resume per burst of typing: each key restarts a short wait, and the resume (or the join of
  // one in flight) carries everything typed by then.
  const resumeSoon = () => {
    if (fire.current !== null) window.clearTimeout(fire.current)
    fire.current = window.setTimeout(() => { fire.current = null; onResumeRef.current(held.current) }, 150)
  }
  useEffect(() => () => {
    if (fire.current === null) return
    window.clearTimeout(fire.current)
    fire.current = null
    onResumeRef.current(held.current)
  }, [])
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="button"
      aria-label={resuming ? 'Resuming the lane' : 'Suspended. Click to resume'}
      onClick={() => onResume(held.current)}
      onKeyDown={(e) => {
        const next = overlayKey(held.current, e)
        if (!next) return
        e.preventDefault()
        held.current = next.held
        resumeSoon()
      }}
      style={{
        position: 'absolute', inset: 0,
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center', paddingBottom: 16,
        background: 'color-mix(in srgb, var(--bg-terminal) 60%, transparent)',
        cursor: resuming ? 'progress' : 'pointer', outline: 'none',
        fontFamily: 'var(--font-body)',
      }}
    >
      <span
        style={{
          padding: '6px 12px',
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 999,
          boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
          fontSize: 11, color: 'var(--fg-muted)',
        }}
      >
        {resuming ? 'Resuming…' : 'Suspended — click to resume'}
      </span>
    </div>
  )
}
