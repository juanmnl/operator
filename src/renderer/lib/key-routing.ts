// Single source of truth for which key chords belong to the APP (palette, new/
// close session, sidebar toggle, switch-terminal 1-9) rather than the terminal.
// Both the window-level shortcut handler (DashboardView) and the terminal's
// attachCustomKeyEventHandler consult this, so routing can't drift between them.

export interface KeyChordEvent {
  metaKey: boolean
  ctrlKey: boolean
  shiftKey?: boolean
  key: string
}

/** True if the chord is an Operator app shortcut (Cmd/Ctrl + K/N/B/W/J or 1-9, plus the
 *  SHIFTED navigation pair ⌘⇧O = all projects and ⌘⇧P = project switcher).
 *  Note: the terminal only DECLINES the Cmd (meta) variants — Ctrl+<letter> are
 *  terminal control codes (^W werase, ^K kill-line) and must reach the pty. */
export function isAppChord(e: KeyChordEvent): boolean {
  if (!(e.metaKey || e.ctrlKey)) return false
  const k = e.key.toLowerCase()
  if (k === 'k' || k === 'n' || k === 'b' || k === 'w' || k === 'j') return true
  // Only the SHIFTED forms are ours: plain ⌘O / ⌘P have no app meaning, so they stay the
  // terminal's (and can't be silently swallowed here).
  if (e.shiftKey && (k === 'o' || k === 'p')) return true
  if (e.key.length === 1 && e.key >= '1' && e.key <= '9') return true
  return false
}
