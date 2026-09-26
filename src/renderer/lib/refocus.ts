// WHERE KEYBOARD FOCUS GOES WHEN THE USER COMES BACK TO THE APP (Cmd-Tab, the Dock icon, a click on
// the window). Pure, so the decision is testable without a window.
//
// The rules, in order:
//   1. Never take focus from a text field, a dialog, or an embedded page (the Preview) the user was
//      in before they switched away: if one is focused now (Chromium restored it) or was focused when
//      the window lost focus and is still on screen, that element keeps or gets focus back.
//   2. A lane is on screen: its terminal input.
//   3. Another view is on screen with a primary input (the board's task composer): that input.
//   4. Otherwise nothing: focus stays wherever the platform put it.

/** What kind of element held focus. */
export type FocusKind =
  /** An editable field: input of a text kind, textarea, contenteditable. Not a terminal's input. */
  | 'text-field'
  /** Any focusable element inside an open dialog. */
  | 'dialog'
  /** A terminal's hidden input (xterm's helper textarea). */
  | 'terminal'
  /** An embedded page (the Preview's iframe). Its own focused element is invisible from here, and may
   *  be a field in the app being previewed, so it is treated like a text field: never taken from. */
  | 'embedded'
  /** Anything else: a button, the body, nothing. */
  | 'other'

const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number'])

/** The minimal element surface `classifyFocus` reads, so tests can pass plain objects. */
export interface FocusableLike {
  tagName: string
  type?: string
  isContentEditable?: boolean
  classList?: { contains(c: string): boolean }
  closest?: (selector: string) => unknown
}

export function classifyFocus(el: FocusableLike | null | undefined): FocusKind {
  if (!el || !el.tagName) return 'other'
  const tag = el.tagName.toLowerCase()
  if (tag === 'body' || tag === 'html') return 'other'
  if (el.classList?.contains('xterm-helper-textarea')) return 'terminal'
  if (tag === 'iframe') return 'embedded'
  if (el.closest?.('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]')) return 'dialog'
  if (tag === 'textarea' || el.isContentEditable) return 'text-field'
  if (tag === 'input' && TEXT_INPUT_TYPES.has((el.type ?? '').toLowerCase())) return 'text-field'
  return 'other'
}

export type RefocusPlan =
  /** Leave focus where it is: a field or dialog the user was using already has it. */
  | { kind: 'keep' }
  /** Put focus back on the element that had it when the window lost focus. */
  | { kind: 'restore' }
  | { kind: 'terminal'; terminalId: string }
  | { kind: 'primary-input' }
  | { kind: 'none' }

export interface RefocusInput {
  /** What holds focus now, after the platform restored what it restores. */
  current: FocusKind
  /** What held focus when the window lost it, and whether that element is still connected and
   *  visible. `undefined` when nothing was recorded. */
  remembered?: { kind: FocusKind; usable: boolean }
  /** The terminal id of the lane on screen, when a lane is on screen (not a board, not settings). */
  laneOnScreen?: string
  /** The view on screen has a visible primary input. */
  hasPrimaryInput: boolean
}

export function refocusTarget(s: RefocusInput): RefocusPlan {
  const typing = (k: FocusKind) => k === 'text-field' || k === 'dialog' || k === 'embedded'
  if (typing(s.current)) return { kind: 'keep' }
  if (s.remembered && typing(s.remembered.kind) && s.remembered.usable) return { kind: 'restore' }
  if (s.laneOnScreen) return { kind: 'terminal', terminalId: s.laneOnScreen }
  if (s.hasPrimaryInput) return { kind: 'primary-input' }
  return { kind: 'none' }
}
