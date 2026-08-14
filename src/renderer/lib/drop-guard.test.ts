import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installDropGuard } from './drop-guard'

// jsdom has no DragEvent/DataTransfer, and the guard only ever reads `types` and writes
// `dropEffect` — so a plain cancelable Event carrying a stub is a faithful stand-in.
type Stub = { types: readonly string[]; dropEffect?: string }

function fire(el: Element, type: 'dragenter' | 'dragover' | 'drop', dt: Stub | null = { types: ['Files'] }) {
  const e = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(e, 'dataTransfer', { value: dt })
  el.dispatchEvent(e)
  return e
}

let root: HTMLDivElement
beforeEach(() => {
  root = document.createElement('div')
  document.body.appendChild(root)
})
afterEach(() => {
  root.remove()
})

describe('the defect: an unhandled file drop navigates the webview away', () => {
  it('cancels a file drop on a plain, non-target element', () => {
    const off = installDropGuard()
    root.innerHTML = '<div id="plain">not a drop target</div>'
    expect(fire(root.querySelector('#plain')!, 'drop').defaultPrevented).toBe(true)
    off()
  })

  // Cancelling only `drop` still navigates: an uncancelled dragover means the drop event is
  // never dispatched at all.
  it('cancels the DRAGOVER too', () => {
    const off = installDropGuard()
    const dt: Stub = { types: ['Files'] }
    const e = fire(root, 'dragover', dt)
    expect(e.defaultPrevented).toBe(true)
    // Nothing here accepts the drag, so the cursor should say so.
    expect(dt.dropEffect).toBe('none')
    off()
  })

  // The tick a drag ENTERS a new element dispatches `dragenter`, not `dragover`, and WebKit takes
  // that event's cancellation as the answer for the tick. A flick released before the pointer
  // moves again is decided here and nowhere else — which is how the original incident happened.
  it('cancels the DRAGENTER too — a flick that never gets a second tick', () => {
    const off = installDropGuard()
    expect(fire(root, 'dragenter').defaultPrevented).toBe(true)
    off()
  })

  // …but it must NOT write `dropEffect` there. No app drop target listens for `dragenter` — they
  // all decide on `dragover` — so a "none" on this tick would refuse a drag the composer is about
  // to accept, and a flick released on exactly that tick would lose the file rather than attach
  // it. Cancelling alone takes the drop away from the navigation default and leaves the drop
  // firing, which is all the backstop needs.
  it('does not force dropEffect on dragenter — a target may still claim the drag', () => {
    const off = installDropGuard()
    const dt: Stub = { types: ['Files'], dropEffect: 'copy' }
    // Cancelled (so the webview cannot navigate) but the effect is left where it was.
    expect(fire(root, 'dragenter', dt).defaultPrevented).toBe(true)
    expect(dt.dropEffect).toBe('copy')
    off()
  })

  it('cancels a dragged URL too — a link dropped on the page navigates the same way', () => {
    const off = installDropGuard()
    expect(fire(root, 'dragover', { types: ['text/uri-list', 'text/plain'] }).defaultPrevented).toBe(true)
    expect(fire(root, 'drop', { types: ['text/uri-list', 'text/plain'] }).defaultPrevented).toBe(true)
    off()
  })

  it('guards a drag whose payload cannot be read at all', () => {
    const off = installDropGuard()
    expect(fire(root, 'dragover', null).defaultPrevented).toBe(true)
    expect(fire(root, 'drop', null).defaultPrevented).toBe(true)
    off()
  })

  it('stops guarding once disposed', () => {
    const off = installDropGuard()
    off()
    expect(fire(root, 'drop').defaultPrevented).toBe(false)
    expect(fire(root, 'dragover').defaultPrevented).toBe(false)
    expect(fire(root, 'dragenter').defaultPrevented).toBe(false)
  })
})

describe('the five existing drop targets keep working unchanged', () => {
  it('lets a target see the event first and does not overwrite its dropEffect', () => {
    const off = installDropGuard()
    const target = document.createElement('div')
    root.appendChild(target)
    let sawDragOver = 0
    let sawDrop = 0
    // What ChatComposer/TerminalPane/MoodboardPanel do: claim the drag on dragover.
    target.addEventListener('dragover', (e) => {
      sawDragOver++
      e.preventDefault()
      e.dataTransfer!.dropEffect = 'copy'
    })
    target.addEventListener('drop', (e) => { sawDrop++; e.preventDefault() })

    const dt: Stub = { types: ['Files'] }
    fire(target, 'dragover', dt)
    fire(target, 'drop', dt)
    expect(sawDragOver).toBe(1)
    expect(sawDrop).toBe(1)
    expect(dt.dropEffect).toBe('copy')
    off()
  })

  it('is a no-op for a target that stops propagation (the lane-reorder shape)', () => {
    const off = installDropGuard()
    const row = document.createElement('div')
    root.appendChild(row)
    let reordered = 0
    row.addEventListener('drop', (e) => { reordered++; e.preventDefault(); e.stopPropagation() })
    const e = fire(row, 'drop', { types: ['operator/lane-code'] })
    expect(reordered).toBe(1)
    expect(e.defaultPrevented).toBe(true)
    off()
  })

  // THE REGRESSION THIS SCOPE EXISTS FOR (R4/R5 of dev/drive-lane-reorder.mjs): the rail refuses
  // a cross-kind or cross-project lane drag by NOT cancelling dragover, and the harness reads
  // that refusal off `defaultPrevented`. A blanket guard turns every refusal into an accept.
  it('leaves an in-app drag the rail REFUSED still refused', () => {
    const off = installDropGuard()
    const row = document.createElement('div')
    root.appendChild(row)
    const dt: Stub = { types: ['operator/adhoc'] }
    expect(fire(row, 'dragover', dt).defaultPrevented).toBe(false)
    expect(dt.dropEffect).toBeUndefined()
    expect(fire(row, 'drop', dt).defaultPrevented).toBe(false)
    off()
  })

  it('leaves a plain-text drag alone anywhere — it has no navigating default', () => {
    const off = installDropGuard()
    expect(fire(root, 'dragover', { types: ['text/plain'] }).defaultPrevented).toBe(false)
    expect(fire(root, 'drop', { types: ['text/plain'] }).defaultPrevented).toBe(false)
    off()
  })
})

describe('text fields keep their native drag-to-edit', () => {
  beforeEach(() => {
    root.innerHTML = '<textarea></textarea><input><div contenteditable="true"><span>x</span></div><div id="plain"></div>'
  })

  it('lets a dragged URL land in an input, textarea or contenteditable', () => {
    const off = installDropGuard()
    for (const sel of ['textarea', 'input', '[contenteditable="true"] span']) {
      const el = root.querySelector(sel)!
      expect(fire(el, 'dragover', { types: ['text/uri-list'] }).defaultPrevented).toBe(false)
      expect(fire(el, 'drop', { types: ['text/uri-list'] }).defaultPrevented).toBe(false)
    }
    off()
  })

  it('still guards a FILE dropped on a text field — that navigates too', () => {
    const off = installDropGuard()
    const ta = root.querySelector('textarea')!
    expect(fire(ta, 'dragover', { types: ['Files'] }).defaultPrevented).toBe(true)
    expect(fire(ta, 'drop', { types: ['Files'] }).defaultPrevented).toBe(true)
    off()
  })

  it('guards a dragged URL that lands anywhere else', () => {
    const off = installDropGuard()
    const plain = root.querySelector('#plain')!
    expect(fire(plain, 'drop', { types: ['text/uri-list'] }).defaultPrevented).toBe(true)
    off()
  })

  it('lets a URL land in a plaintext-only region — WebKit supports it and it takes the text', () => {
    const off = installDropGuard()
    root.innerHTML = '<div contenteditable="plaintext-only"><span>y</span></div>'
    const span = root.querySelector('span')!
    expect(fire(span, 'dragover', { types: ['text/uri-list'] }).defaultPrevented).toBe(false)
    off()
  })
})

// THE CARVE-OUT IS ABOUT EDITABILITY, NOT TAGS. A field that cannot absorb the text is not a text
// field, whatever its tag says: the URL falls straight through to the webview's navigation
// default, which is the thing this file exists to stop. Asking by tag got every row below wrong.
describe('a field that cannot take the text gets no pass', () => {
  const cases: Array<[string, string]> = [
    ['a readonly textarea', '<textarea readonly></textarea>'],
    ['a disabled textarea', '<textarea disabled></textarea>'],
    ['a readonly text input', '<input readonly>'],
    ['a disabled text input', '<input disabled>'],
    ['a checkbox', '<input type="checkbox">'],
    ['a range slider', '<input type="range">'],
    ['an input-shaped button', '<input type="button" value="b">'],
    ['a contenteditable="false" island', '<div contenteditable="false"><span>n</span></div>'],
  ]
  for (const [name, html] of cases) {
    it(`guards a dragged URL over ${name}`, () => {
      const off = installDropGuard()
      root.innerHTML = html
      const el = root.querySelector('span') ?? root.firstElementChild!
      expect(fire(el, 'dragover', { types: ['text/uri-list'] }).defaultPrevented).toBe(true)
      expect(fire(el, 'drop', { types: ['text/uri-list'] }).defaultPrevented).toBe(true)
      off()
    })
  }

  it('still lets the text-entry input types through', () => {
    const off = installDropGuard()
    root.innerHTML = '<input type="text"><input type="search"><input type="url"><input type="tel"><input type="email"><input type="password"><input type="number"><input>'
    for (const el of root.querySelectorAll('input')) {
      expect(fire(el, 'dragover', { types: ['text/uri-list'] }).defaultPrevented).toBe(false)
    }
    off()
  })
})
