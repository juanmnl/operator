// WHERE KEYBOARD FOCUS GOES WHEN THE USER COMES BACK TO THE APP (Cmd-Tab, the Dock icon, a click on
// the window). Pure, so the decision is testable without a window.
//
// The rules, in order:
//   1. If the user has clicked or typed since the app was activated, they chose: change nothing.
//   2. If ANY element other than the page body has focus, keep it: a text field, a dialog, the
//      Preview's page, a menu, a tab, a button, or the terminal the click landed in. Moving focus off a
//      control would close an open menu (they dismiss on focus leaving) and override a choice.
//   3. Focus is on the body or nowhere, so the platform restored nothing useful:
//        a. the text field, dialog or embedded page the user was in when the app lost focus, if it is
//           still on screen;
//        b. else the terminal of the lane on screen;
//        c. else the view's primary input (the empty board's task composer);
//        d. else nothing.
// A terminal input that has focus while its lane is NOT on screen (the board or settings is showing)
// counts as the body: it is hidden, and typing into it would be typing blind.
//
// dev/results/review-refocus-2026-09-26.md: the first version restored a remembered element whenever
// the focused one was not a text field, so a click on the terminal, or anywhere after using the
// Preview, was pulled back to the remembered field or into the iframe a frame later.

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
  /** Any other focused control: a button, a tab, a menu item, a checkbox. */
  | 'other'
  /** The page body, or nothing: focus is nowhere in particular. */
  | 'none'

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
  if (!el || !el.tagName) return 'none'
  const tag = el.tagName.toLowerCase()
  if (tag === 'body' || tag === 'html') return 'none'
  if (el.classList?.contains('xterm-helper-textarea')) return 'terminal'
  if (tag === 'iframe') return 'embedded'
  if (el.closest?.('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]')) return 'dialog'
  if (tag === 'textarea' || el.isContentEditable) return 'text-field'
  if (tag === 'input' && TEXT_INPUT_TYPES.has((el.type ?? '').toLowerCase())) return 'text-field'
  return 'other'
}

export type RefocusPlan =
  /** Leave focus where it is. */
  | { kind: 'keep' }
  /** Put focus back on the element that had it when the app lost focus. */
  | { kind: 'restore' }
  | { kind: 'terminal'; terminalId: string }
  | { kind: 'primary-input' }

export interface RefocusInput {
  /** What holds focus now, after the platform restored what it restores. */
  current: FocusKind
  /** The user clicked or typed after the activation: whatever they did is their choice. */
  userActedSinceActivation?: boolean
  /** What held focus when the APP lost focus (not when focus moved into an iframe), and whether that
   *  element is still connected and visible. `undefined` when nothing was recorded. */
  remembered?: { kind: FocusKind; usable: boolean }
  /** The terminal id of the lane on screen, when a lane is on screen (not a board, not settings). */
  laneOnScreen?: string
  /** The view on screen has a visible primary input. */
  hasPrimaryInput: boolean
}

export function refocusTarget(s: RefocusInput): RefocusPlan {
  if (s.userActedSinceActivation) return { kind: 'keep' }
  // A terminal input focused while no lane is on screen is hidden: as good as nothing.
  const current = s.current === 'terminal' && !s.laneOnScreen ? 'none' : s.current
  if (current !== 'none') return { kind: 'keep' }
  const worthRestoring = (k: FocusKind) => k === 'text-field' || k === 'dialog' || k === 'embedded'
  if (s.remembered && worthRestoring(s.remembered.kind) && s.remembered.usable) return { kind: 'restore' }
  if (s.laneOnScreen) return { kind: 'terminal', terminalId: s.laneOnScreen }
  if (s.hasPrimaryInput) return { kind: 'primary-input' }
  return { kind: 'keep' }
}
