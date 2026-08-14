import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installDropGuard } from './drop-guard'

// jsdom has no DragEvent/DataTransfer, and the guard only ever reads `types` and writes
// `dropEffect` — so a plain cancelable Event carrying a stub is a faithful stand-in.
type Stub = { types: readonly string[]; dropEffect?: string }

function fire(el: Element, type: 'dragover' | 'drop', dt: Stub | null = { types: ['Files'] }) {
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
})
