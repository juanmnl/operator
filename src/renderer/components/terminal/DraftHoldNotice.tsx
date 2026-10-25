import { useSyncExternalStore } from 'react'
import { submitQueue } from '../../lib/submit-queue'
import { draftUnknown, onDraftChange } from '../../lib/lane-keystrokes'

// One subscription for both stores: a hold change, or a draft change (an unknown draft becomes a
// known one at the first key typed into it, with the hold unchanged).
const subscribe = (fn: () => void) => {
  const offHold = submitQueue.onHoldChange(fn)
  const offDraft = onDraftChange(() => fn())
  return () => { offHold(); offDraft() }
}

/** The line saying a lane's messages are waiting on what the person typed (lib/submit-queue,
 *  2026-10-24). A delivery pasted into a half-typed line used to be merged into it and sent; it now
 *  waits until the line is sent or cleared, with no timeout. Without this the lane looks as if
 *  nothing reached it.
 *
 *  At the top of the pane, away from the composer at the bottom, and only the pill takes the
 *  pointer, so the terminal under it can still be clicked and selected. "Deliver now" is the
 *  person's choice to merge: the next message is pasted into their text and sent with it, and any
 *  after it wait again (review F2).
 *
 *  After a reload the draft is UNKNOWN (lib/lane-keystrokes `restoreDrafts`): main kept the flag,
 *  but the person may have sent or cleared the text since. The line says so; Enter, Ctrl+C, a
 *  double Esc or Deliver now settles it. */
export function DraftHoldNotice({ terminalId }: { terminalId: string }) {
  const held = useSyncExternalStore(subscribe, () => submitQueue.heldForDraft(terminalId))
  const unknown = useSyncExternalStore(subscribe, () => draftUnknown(terminalId))
  if (!held) return null
  const count = held === 1 ? '1 message waits' : `${held} messages wait`
  return (
    <div
      style={{
        position: 'absolute', left: 0, right: 0, top: 12,
        display: 'flex', justifyContent: 'center',
        pointerEvents: 'none',
        fontFamily: 'var(--font-body)',
      }}
    >
      <div
        role="status"
        style={{
          pointerEvents: 'auto',
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '6px 8px 6px 12px',
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 999,
          boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
          fontSize: 11, color: 'var(--fg)',
        }}
      >
        <span>
          {unknown
            ? `${count}: after the reload, Operator can’t tell if you left text here`
            : `${count} until you send or clear what you typed`}
        </span>
        <button
          onClick={() => submitQueue.deliverNow(terminalId)}
          title="Deliver now: the next message is added to what you typed and sent with it"
          style={{
            background: 'var(--btn-bg)', color: 'var(--fg)', border: 'none',
            borderRadius: 999, padding: '3px 12px', fontSize: 11, fontWeight: 500,
            cursor: 'pointer', fontFamily: 'inherit', outline: 'none',
          }}
        >
          Deliver now
        </button>
      </div>
    </div>
  )
}
