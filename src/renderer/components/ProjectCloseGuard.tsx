import { GuardDialog } from './GuardDialog'
import type { CloseGuardCopy, CloseGuardRow } from '../lib/project-close-guard'

// Close project's confirm (lifecycle UX audit B2). Opened only when the close will end lanes;
// with none, the project closes at once. The caller freezes rows and copy when it opens.

export function ProjectCloseGuard({ copy, rows, onKeep, onEnd, restoreFocus }: {
  copy: CloseGuardCopy
  rows: CloseGuardRow[]
  onKeep: () => void
  onEnd: () => void
  /** Opened from a menu or the palette, it has nothing to give focus back to (review T2). */
  restoreFocus?: () => void
}) {
  return (
    <GuardDialog
      id="project-close-guard"
      title={copy.title}
      body={copy.body}
      rows={rows.map((r) => ({ key: r.terminalId, name: r.name, state: r.state, wave: r.wave, accent: r.accent }))}
      overflow={copy.overflow}
      note={copy.midTurn}
      hint={copy.hint}
      safeVerb={copy.keepVerb}
      dangerVerb={copy.endVerb}
      onSafe={onKeep}
      onDanger={onEnd}
      restoreFocus={restoreFocus}
    />
  )
}
