import { useState } from 'react'
import type { OfferBlocker, PreviousRunOffer } from '../../lib/workspace'
import { BACK_BTN as backBtn } from '../../lib/chrome'

// THE PREVIOUS RUN'S LANES, on the home overview a launch opens on. One card for every project, so
// what comes back no longer depends on which project happened to have focus when the app stopped.
// It replaces a launch toast that was gone in seconds and spoke for one project only.
//
// Offer only: auto-resume stays a setting, default off (lib/workspace). The card stays until its
// lanes are back or it is dismissed; dismissing forgets the offer, not the lanes, which stay in the
// sidebar and on Project Home.

export interface ResumeCardProps {
  offer: PreviousRunOffer
  /** While the button runs: lanes started so far, of how many. */
  progress: { done: number; total: number } | null
  onResume: () => void
  onDismiss: () => void
}

/** `a b c` → `a b c`: the last two words never split, so no line ends with one word alone. */
const bindLast = (s: string) => s.replace(/ (\S+)$/, ' $1')
const lanesWord = (n: number) => `${n} ${n === 1 ? 'lane' : 'lanes'}`

const BLOCKER_TEXT: Record<OfferBlocker, string> = {
  'folder-missing': 'folder gone',
  'no-conversation': 'no saved conversation',
  'project-forgotten': 'project forgotten',
  'project-shelved': 'project shelved',
  'released': 'finished, worktree released',
  'did-not-start': 'did not start',
}

export function ResumeCard({ offer, progress, onResume, onDismiss }: ResumeCardProps) {
  const [hover, setHover] = useState(false)
  const n = offer.resumable.length
  const title = n
    ? `Resume ${lanesWord(n)} from before this launch`
    : `${lanesWord(offer.blocked.length)} from before this launch can’t be resumed`
  return (
    <div data-resume-card style={{
      display: 'flex', flexDirection: 'column', gap: 8,
      margin: '6px 0 12px', padding: '10px 10px 10px 12px', boxSizing: 'border-box',
      borderRadius: 'var(--radius-sm)', background: 'var(--overlay-subtle)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fg)', minWidth: 0 }}>{bindLast(title)}</span>
        {n > 0 && (
          <button
            data-resume-all
            onClick={onResume}
            disabled={!!progress}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            title="Start each of these lanes again with its conversation (--resume), oldest first, in the background"
            style={{
              ...backBtn, marginLeft: 'auto', flexShrink: 0, whiteSpace: 'nowrap',
              color: 'var(--fg)', fontWeight: 600, fontVariantNumeric: 'tabular-nums',
              background: hover && !progress ? 'var(--overlay-medium)' : 'transparent',
              cursor: progress ? 'default' : 'pointer',
            }}
          >
            {progress ? `Resuming ${progress.done + 1} of ${progress.total}…` : 'Resume'}
          </button>
        )}
        {!progress && (
          <button
            aria-label="Dismiss"
            onClick={onDismiss}
            title={'Don’t offer these lanes again. They\u00a0stay in the sidebar and on each project’s home.'}
            style={{
              marginLeft: n > 0 ? 0 : 'auto', flexShrink: 0, width: 18, height: 18, padding: 0,
              display: 'grid', placeItems: 'center',
              background: 'transparent', border: 'none', borderRadius: 4, outline: 'none',
              color: 'var(--fg-muted)', cursor: 'pointer',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--fg)' }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--fg-muted)' }}
          >
            <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <path d="M1.5 1.5 L8.5 8.5 M8.5 1.5 L1.5 8.5" />
            </svg>
          </button>
        )}
      </div>

      {offer.projects.length > 0 && (
        <div aria-label="Lanes per project" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {offer.projects.map((p) => (
            <span key={p.projectId ?? p.name} data-resume-project={p.projectId ?? ''} style={{
              display: 'inline-flex', alignItems: 'center', gap: 5, height: 20, padding: '0 7px', boxSizing: 'border-box',
              border: '1px solid var(--border)', borderRadius: 4, background: 'transparent',
              fontSize: 11, whiteSpace: 'nowrap', maxWidth: 240,
            }}>
              <span style={{ color: 'var(--fg)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
              <span style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)', fontSize: 10.5, fontVariantNumeric: 'tabular-nums' }}>{p.lanes}</span>
            </span>
          ))}
        </div>
      )}

      {offer.blocked.length > 0 && (
        <span data-resume-blocked style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>
          {bindLast(`${n ? 'Left out: ' : ''}${offer.blocked.map((b) => `${b.name} (${BLOCKER_TEXT[b.blocker]})`).join(', ')}`)}
        </span>
      )}
    </div>
  )
}
