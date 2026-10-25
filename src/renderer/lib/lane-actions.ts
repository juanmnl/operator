// ONE LANE'S ACTIONS MENU, as data (lifecycle UX audit B1 and task 9, approved 2026-10-24).
//
// Close at the collapsed rail width needed the expanded panel, so a lane's verbs now live in one
// menu with three ways in: the toolbar's ⋯, and a right-click on the lane's orb or row at either
// width. Colour moved into it, since the right-click used to open the colour picker directly.
// DashboardView builds the input and maps each `action` to its handler.

export type LaneAction = 'close' | 'restart' | 'suspend' | 'colour'

export interface LaneActionItem {
  id: string
  action: LaneAction
  label: string
  hint?: string
  confirm?: boolean
  disabled?: boolean
  separator?: boolean
}

export interface LaneActionsInput {
  /** It is the lane on screen, the one ⌘W closes. */
  active: boolean
  /** Running or suspended: closing it loses something (a turn, or the conversation to resume). */
  live: boolean
  /** It has a terminal id; without one there is nothing to close. */
  closable: boolean
  /** Present when the lane runs an older Claude Code than the installed one. */
  restart?: { version: string; canRestart: boolean }
  /** The suspend rules allow it now (DashboardView `canSuspendByHand`). */
  canSuspend: boolean
}

/** The items, in the audit's order: Close, Restart, Suspend, then Colour under a hairline.
 *
 *  Close arms when the lane is live (CardMenu `confirm`). ⌘W is shown only on the lane it closes.
 *  Restart and Suspend appear only when they apply: an item that is never usable for most lanes
 *  would be noise in every menu. Restart is listed while busy, disabled, so the menu says why the
 *  toolbar's Restart is not live yet. */
export function laneActionItems(l: LaneActionsInput): LaneActionItem[] {
  const items: LaneActionItem[] = [{
    id: 'lane-close',
    action: 'close',
    label: 'Close session',
    hint: l.active ? '⌘W' : undefined,
    confirm: l.live,
    disabled: !l.closable,
  }]
  if (l.restart) {
    items.push({ id: 'lane-restart', action: 'restart', label: `Restart on Claude Code ${l.restart.version}`, disabled: !l.restart.canRestart })
  }
  if (l.canSuspend) items.push({ id: 'lane-suspend', action: 'suspend', label: 'Suspend — keep the conversation' })
  items.push({ id: 'lane-colour', action: 'colour', label: 'Lane colour…', separator: true })
  return items
}
