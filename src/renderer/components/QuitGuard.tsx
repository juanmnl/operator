import { useMemo } from 'react'
import { GuardDialog } from './GuardDialog'
import { quitGuardCopy, quitGuardRows, type LaneIdentity, type QuitRequest } from '../lib/quit-guard'

// THE APP'S FIRST REAL DIALOG, on the skeleton it now shares with the project close guard
// (GuardDialog). ⌘Q while this is open does nothing (Rust holds `prompting`), so nobody quits by
// double-firing the shortcut.

export function QuitGuard({ request, identify, onStay, onQuit }: {
  /** The frozen snapshot from Rust. Deliberately not live: a list that re-orders or a dialog
   *  that vanishes under a moving pointer is a mis-click generator, and a mis-click here is the
   *  accident again. */
  request: QuitRequest
  identify: (terminalId: string) => LaneIdentity | undefined
  onStay: () => void
  onQuit: () => void
}) {
  const copy = useMemo(() => quitGuardCopy(request), [request])
  const { rows } = useMemo(() => quitGuardRows(request, identify), [request, identify])
  return (
    <GuardDialog
      id="quit-guard"
      title={copy.title}
      body={copy.body}
      rows={rows.map((r) => ({ key: r.terminalId, name: r.name, state: r.state, wave: r.phase, accent: r.accent }))}
      overflow={copy.overflow}
      note={copy.idle}
      hint={copy.hint}
      safeVerb={copy.stayVerb}
      dangerVerb={copy.quitVerb}
      onSafe={onStay}
      onDanger={onQuit}
    />
  )
}
