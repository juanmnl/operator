import { classifyFocus, refocusTarget, type FocusableLike, type RefocusPlan } from './refocus'

// THE EVENT HALF of refocus-on-activate, with the DOM injected so a sequence of events (a click into
// the Preview iframe, a click back, an app switch) can be replayed in a test.
//
// WHAT COUNTS AS ACTIVATION (dev/results/review-refocus-2026-09-26.md, finding 1): main's
// `onWindowActivated` (sent on BrowserWindow 'focus' and app 'activate') and the document becoming
// visible after it was hidden. NOT the page's own `window` 'focus'/'blur': those also fire whenever
// focus moves into the Preview's iframe and back out, and acting on them pulled every click out of the
// Preview back into it a frame later.
//
// WHAT IS REMEMBERED: the focused element when the APP lost focus. A `window` 'blur' is also what the
// page gets when focus merely moves into an iframe; then the document still has focus in the page's
// sense (`document.hasFocus()`) and the focused element is the iframe. Such a blur records nothing.
//
// THE USER'S CHOICE WINS (finding 2): a pointer or key event after the activation means focus is
// where the user put it, and the decision changes nothing.

export interface RefocusDeps<E extends FocusableLike> {
  activeElement(): E | null
  /** `document.hasFocus()`: false once the app itself has lost focus. */
  hasFocus(): boolean
  now(): number
  /** Run after the platform's own focus bookkeeping: a macrotask (setTimeout 0) in the app. */
  defer(fn: () => void): void
  /** Run on the next frame, after the platform restored its focused element. */
  nextFrame(fn: () => void): void
  isUsable(el: E): boolean
  laneOnScreen(): string | undefined
  primaryInput(): E | null
  focusElement(el: E): void
  focusTerminal(terminalId: string): void
}

export interface RefocusController {
  /** The page's `window` 'blur'. Records the focused element only if the APP lost focus. */
  onWindowBlur(): void
  /** A pointerdown or keydown anywhere (capture phase). */
  onUserInput(): void
  /** main's `onWindowActivated`, or the document becoming visible. */
  onActivated(): void
  /** For tests: the last plan applied. */
  lastPlan(): RefocusPlan | undefined
}

export function createRefocusController<E extends FocusableLike>(d: RefocusDeps<E>): RefocusController {
  let remembered: E | null = null
  let activatedAt = -Infinity
  let lastInputAt = -Infinity
  let queued = false
  let last: RefocusPlan | undefined

  const apply = () => {
    queued = false
    const input = d.primaryInput()
    const plan = refocusTarget({
      current: classifyFocus(d.activeElement()),
      userActedSinceActivation: lastInputAt >= activatedAt,
      remembered: remembered ? { kind: classifyFocus(remembered), usable: d.isUsable(remembered) } : undefined,
      laneOnScreen: d.laneOnScreen(),
      hasPrimaryInput: !!input,
    })
    last = plan
    try {
      if (plan.kind === 'restore' && remembered) d.focusElement(remembered)
      else if (plan.kind === 'terminal') d.focusTerminal(plan.terminalId)
      else if (plan.kind === 'primary-input' && input) d.focusElement(input)
    } catch { /* torn down between the check and the focus */ }
    // Used once: a later activation must not restore an element from an older switch.
    remembered = null
  }

  return {
    onWindowBlur() {
      const el = d.activeElement()
      // Decided after the blur settles: moving into an iframe keeps the document focused, leaving the
      // app does not. The iframe itself is never recorded either way.
      d.defer(() => {
        if (d.hasFocus()) return
        remembered = el && classifyFocus(el) !== 'embedded' ? el : null
      })
    },
    onUserInput() { lastInputAt = d.now() },
    onActivated() {
      activatedAt = d.now()
      if (queued) return
      queued = true
      d.nextFrame(apply)
    },
    lastPlan: () => last,
  }
}
