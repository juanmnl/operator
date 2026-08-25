import { describe, it, expect } from 'vitest'
import { SURFACE_FILL, PANEL_SUBHEAD_H, TOOLBAR_BAND_H } from './chrome'

// THE GUARD BEHIND `SURFACE_FILL`. Files shipped in 0.18.0 unable to scroll vertically, and
// the cause was not an overflow rule anywhere near a scroller: `FilesView`'s root asked for its
// height with `flex: 1`, the main-view overlay it lands in is a plain block, so the root sized to
// its content and the overlay's `overflow: hidden` clipped the rest. Nothing below the fold was
// reachable by wheel or by key, because nothing in the chain had a bounded height to scroll
// within.
//
// A layout bug cannot be measured here — jsdom has no layout engine, and the real proof is
// `dev/drive-files-scroll.mjs`, which measures the rendered boxes in a browser. What CAN be held
// here, on every `npm test`, is the rule that would have prevented it: a surface mounted into that
// overlay must state an EXPLICIT height, because `flex` is inert in a block parent.
//
// Same shape as `muted-opacity.guard.test.ts` — a rule enforced only by review is not enforced.

const SOURCES = import.meta.glob('../**/*.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

/** Every surface mounted into a slot that is a BLOCK rather than a flex column. A new main view
 *  or a new panel tab belongs on this list. */
const BLOCK_SLOT_SURFACES = [
  // the main view's absolute overlay, one per `mainView` value
  'components/session/CanvasConversation.tsx',
  'components/files/FilesView.tsx',
  'components/session/AppPreviewPanel.tsx',
  // the right panel's body div — a `flex: 1` block, and the second half of the same bug
  'components/files/FilesPanel.tsx',
]

function sourceOf(suffix: string): string {
  const key = Object.keys(SOURCES).find((k) => k.endsWith(suffix))
  if (!key) throw new Error(`no source globbed for ${suffix} — has it moved?`)
  return SOURCES[key]
}

/** Strip comments, so the guard matches DECLARATIONS and not the prose about them. Every one of
 *  these files carries a comment naming the rule, and matching those is how a guard passes over
 *  the very code it was written to fail. (`muted-opacity.guard.test.ts` learned this first.) */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(Math.max(0, m.length - p1.length)))
}

/** The style object on the component's ROOT element — the last `return (` in the file, then the
 *  first `style={{ … }}` inside it. An inner pane saying `height: '100%'` proves nothing about
 *  the box the overlay actually measures, which is the one that shipped unsized. */
function rootStyle(src: string): string {
  const body = stripComments(src)
  const ret = body.lastIndexOf('return (')
  const at = body.indexOf('style={{', ret === -1 ? 0 : ret)
  if (at === -1) throw new Error('no root style object found — has the component changed shape?')
  const end = body.indexOf('}}', at)
  return body.slice(at, end === -1 ? undefined : end)
}

describe('SURFACE_FILL', () => {
  it('states an explicit height — the property a block parent actually honours', () => {
    // `flex: 1` is the half that does nothing in the overlay, and is kept only for the flex-column
    // placements. The height is the half that fixes the bug, so it is the one asserted.
    expect(SURFACE_FILL.height).toBe('100%')
  })

  it('keeps the min-0 pair, or a tall child re-inflates the box it was just bounded to', () => {
    // A flex item's floor is its content, not zero. Without these a long file or a deep tree
    // pushes the column back past its parent and the clipping returns.
    expect(SURFACE_FILL.minHeight).toBe(0)
    expect(SURFACE_FILL.minWidth).toBe(0)
  })
})

describe('every surface in a block slot sizes itself for a BLOCK parent', () => {
  it.each(BLOCK_SLOT_SURFACES)('%s declares an explicit height', (suffix) => {
    const root = rootStyle(sourceOf(suffix))
    // Either spelling counts: the shared constant, or the literal it standardises. What fails is
    // a root sized by `flex: 1` alone — the exact shape that shipped broken.
    const explicit = /SURFACE_FILL/.test(root) || /height:\s*'100%'/.test(root)
    expect(explicit).toBe(true)
  })
})

describe('the header bands stay single-sourced', () => {
  it('are the two numbers the components import, not literals typed per file', () => {
    expect(TOOLBAR_BAND_H).toBe(44)
    expect(PANEL_SUBHEAD_H).toBe(30)
  })
})
