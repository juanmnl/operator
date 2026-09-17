import { describe, it, expect, beforeEach, vi } from 'vitest'
// `?raw`, as preview-overlay.test.ts does: the renderer's tsconfig has no node types.
import EDIT_JS from './preview-edit-page.js?raw'
import {
  editRules, normalizeColor, matchToken, retagEdits, diffChanges, sourceFromDebugStack, composeEditMessage,
  stepValue, colorInputValue, editStateMessage, EDIT_STATE_TAG, EDIT_CMD_TAG, type EditState,
} from './preview-edit'

describe('editRules — the owned stylesheet', () => {
  it('writes one !important rule per edited element, in allow-list order', () => {
    expect(editRules([{ uid: 'e1', values: { 'padding-left': '24px', color: 'var(--brand)' } }]))
      .toBe('[data-op-edit="e1"] {\n  padding-left: 24px !important;\n  color: var(--brand) !important;\n}')
  })

  it('drops elements with nothing set, and properties outside the allow-list', () => {
    expect(editRules([{ uid: 'e1', values: {} }, { uid: 'e2', values: { position: 'fixed', display: 'none' } }])).toBe('')
  })

  it('escapes: a value cannot close the rule or add one, and a uid cannot leave the selector', () => {
    const css = editRules([
      { uid: 'e1"] , body { display:none } [x="', values: { width: '10px' } },
      { uid: 'e2', values: { width: '1px; } body { display: none', height: '2px }', color: 'red !important', opacity: '0.5' } },
    ])
    expect(css).toContain('[data-op-edit="e1bodydisplaynonex"]')
    expect(css).not.toMatch(/body \{/)
    expect(css).not.toContain('1px;')
    expect(css).not.toContain('2px }')
    expect(css).not.toContain('red')
    expect(css).toContain('opacity: 0.5 !important;')
  })

  it('works as a stringified copy, the way the page gets it', () => {
    const fn = new Function(`return (${String(editRules)})`)() as typeof editRules
    const edits = [{ uid: 'e9', values: { 'margin-top': '0px' } }]
    expect(fn(edits)).toBe(editRules(edits))
  })
})

describe('colour tokens', () => {
  const tokens = [
    { name: '--brand', value: 'rgb(59, 130, 246)' },
    { name: '--brand-alias', value: 'rgb(59, 130, 246)' },
    { name: '--overlay', value: 'rgba(0, 0, 0, 0.5)' },
    { name: '--none', value: 'rgba(0, 0, 0, 0)' },
  ]

  it('normalises hex, short hex, rgb and rgba spellings', () => {
    expect(normalizeColor('#3B82F6')).toBe('rgb(59, 130, 246)')
    expect(normalizeColor('#fff')).toBe('rgb(255, 255, 255)')
    expect(normalizeColor('rgba(0,0,0,.5)')).toBe('rgba(0, 0, 0, 0.5)')
    expect(normalizeColor('rgb(1 2 3 / 50%)')).toBe('rgba(1, 2, 3, 0.5)')
    expect(normalizeColor('rgba(1, 2, 3, 1)')).toBe('rgb(1, 2, 3)')
  })

  it('matches by resolved value, first declared wins, and ignores transparent', () => {
    expect(matchToken('#3b82f6', tokens)).toBe('--brand')
    expect(matchToken('rgba(0, 0, 0, 0.5)', tokens)).toBe('--overlay')
    expect(matchToken('rgba(0, 0, 0, 0)', tokens)).toBeNull()
    expect(matchToken('transparent', tokens)).toBeNull()
    expect(matchToken('#123456', tokens)).toBeNull()
  })

  it('stringified copies agree', () => {
    const m = new Function(`return (${String(matchToken)})`)() as typeof matchToken
    expect(m('#3b82f6', tokens)).toBe('--brand')
    const n = new Function(`return (${String(normalizeColor)})`)() as typeof normalizeColor
    expect(n('#3B82F6')).toBe(normalizeColor('#3B82F6'))
  })
})

describe('diffChanges — only what the controls touched and actually moved', () => {
  const before = { 'padding-left': '12px', 'padding-right': '12px', color: 'rgb(0, 0, 0)', width: '100px', opacity: '1' }

  it('lists touched properties whose computed value changed, in panel order, with tokens for colours', () => {
    const touched = { color: 'var(--brand)', 'padding-left': '24px', width: '100px' }
    const after = { ...before, 'padding-left': '24px', color: 'rgb(59, 130, 246)' }
    expect(diffChanges(before, touched, after, [{ name: '--brand', value: 'rgb(59, 130, 246)' }])).toEqual([
      { property: 'padding-left', before: '12px', after: '24px', token: null },
      { property: 'color', before: 'rgb(0, 0, 0)', after: 'rgb(59, 130, 246)', token: '--brand' },
    ])
  })

  it('ignores untouched properties even when their computed value moved (a knock-on of another edit)', () => {
    const after = { ...before, 'padding-left': '24px', width: '124px' }
    expect(diffChanges(before, { 'padding-left': '24px' }, after).map((c) => c.property)).toEqual(['padding-left'])
  })

  it('treats the same colour spelled differently as no change', () => {
    expect(diffChanges({ color: 'rgb(0, 0, 0)' }, { color: '#000' }, { color: 'rgb(0, 0, 0)' })).toEqual([])
  })
})

describe('retagEdits — surviving an HMR remount', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  it('tags the replacement element found by the stored selector', () => {
    document.body.innerHTML = '<main><section><button id="a">x</button><p class="card">one</p></section></main>'
    const p = document.querySelector('p')!
    p.setAttribute('data-op-edit', 'e1')
    const selector = 'main:nth-of-type(1) > section:nth-of-type(1) > p:nth-of-type(1)'
    // A remount: the node is replaced by an equal one without the attribute.
    p.replaceWith(Object.assign(document.createElement('p'), { className: 'card', textContent: 'one' }))
    expect(retagEdits(document, [{ uid: 'e1', selector }])).toEqual(['e1'])
    expect(document.querySelector('[data-op-edit="e1"]')?.textContent).toBe('one')
  })

  it('leaves a still-tagged edit alone, never steals another edit’s element, and survives a bad selector', () => {
    document.body.innerHTML = '<div data-op-edit="e2"></div><span data-op-edit="e3"></span>'
    expect(retagEdits(document, [
      { uid: 'e2', selector: 'div' },
      { uid: 'e4', selector: 'span' },
      { uid: 'e5', selector: '>>>' },
    ])).toEqual([])
  })

  it('works as a stringified copy', () => {
    document.body.innerHTML = '<em></em>'
    const fn = new Function(`return (${String(retagEdits)})`)() as typeof retagEdits
    expect(fn(document, [{ uid: 'e6', selector: 'em' }])).toEqual(['e6'])
  })
})

describe('React 19 source fallback', () => {
  it('names the project file from _debugStack and skips dependency frames, with no line', () => {
    const stack = [
      'Error: react-stack-top-frame',
      '    at exports.jsxDEV (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1:250:30)',
      '    at PlanCard (http://localhost:5173/src/Pricing.tsx?t=17:42:9)',
    ].join('\n')
    expect(sourceFromDebugStack(stack)).toBe('src/Pricing.tsx')
    expect(sourceFromDebugStack('Error\n    at x (native)')).toBeNull()
    expect(sourceFromDebugStack(undefined)).toBeNull()
  })
})

describe('the message to the lane', () => {
  it('names the element and source, each change, and the tokens to use', () => {
    const msg = composeEditMessage({
      label: 'button', component: 'PlanCard', source: 'src/Pricing.tsx:42', selector: '#buy', route: '/pricing', scope: 'element',
      changes: [
        { property: 'padding-left', before: '12px', after: '24px', token: null },
        { property: 'color', before: 'rgb(0, 0, 0)', after: 'rgb(59, 130, 246)', token: '--brand' },
      ],
    }, { before: '/s/b.png', after: '/s/a.png' })
    expect(msg).toContain('on /pricing, scope: this element only.')
    expect(msg).toContain('Element: PlanCard @ src/Pricing.tsx:42')
    expect(msg).toContain('- padding-left: 12px → 24px')
    expect(msg).toContain('- color: rgb(0, 0, 0) → var(--brand) (rgb(59, 130, 246))')
    expect(msg).toContain('Before: /s/b.png\nAfter: /s/a.png')
  })

  it('falls back to the selector when there is no source', () => {
    const msg = composeEditMessage({ label: 'div', component: null, source: null, selector: 'main > div', route: '/', scope: 'element', changes: [] })
    expect(msg).toContain('Element: div (main > div)')
    expect(msg).not.toContain('Selector:')
  })
})

describe('field helpers', () => {
  it('steps values keeping the unit, from 0px when unparseable, never under min', () => {
    expect(stepValue('12px', 1)).toBe('13px')
    expect(stepValue('0.5', 0.1)).toBe('0.6')
    expect(stepValue('auto', 4)).toBe('4px')
    expect(stepValue('2px', -10, 0)).toBe('0px')
  })

  it('turns a computed colour into a colour-input value', () => {
    expect(colorInputValue('rgb(59, 130, 246)')).toBe('#3b82f6')
    expect(colorInputValue('garbage')).toBe('#000000')
  })

  it('parses only well-formed state messages', () => {
    const s: EditState = { active: null, count: 0, tokens: [] }
    expect(editStateMessage({ [EDIT_STATE_TAG]: 'state', data: JSON.stringify(s) })).toEqual(s)
    expect(editStateMessage({ [EDIT_STATE_TAG]: 'state', data: '{' })).toBeNull()
    expect(editStateMessage({ other: 1 })).toBeNull()
  })
})

// ── the page script in jsdom ──────────────────────────────────────────────────────────────────
describe('preview-edit-page.js in the page', () => {
  type Win = Window & { __operatorEdit?: { select: (el: Element, meta?: unknown) => void }; __operatorEditFns?: unknown }
  const page = window as Win
  const cmd = (name: string, extra: Record<string, unknown> = {}) =>
    window.dispatchEvent(new MessageEvent('message', { data: { [EDIT_CMD_TAG]: name, ...extra }, source: window }))
  const posted: EditState[] = []
  const last = () => posted[posted.length - 1]

  beforeEach(() => {
    document.head.innerHTML = ''
    document.body.innerHTML = '<main><p id="t" style="padding-left:12px">hi</p><section><b>x</b></section></main>'
    delete page.__operatorEdit
    page.__operatorEditFns = { editRules, retagEdits, normalizeColor, matchToken, sourceFromDebugStack }
    posted.length = 0
    vi.spyOn(window, 'postMessage').mockImplementation((m: unknown) => {
      const s = editStateMessage(m)
      if (s) posted.push(s)
    })
    new Function(EDIT_JS)()
  })

  const style = () => document.getElementById('__op_edits')?.textContent ?? ''

  it('select tags the element and reports it; set writes a rule; undo and reset remove it', () => {
    const p = document.getElementById('t')!
    page.__operatorEdit!.select(p, { selector: '#t', tag: 'p' })
    const uid = p.getAttribute('data-op-edit')!
    expect(uid).toMatch(/^e/)
    expect(last()?.active?.uid).toBe(uid)

    cmd('set', { uid, prop: 'padding-left', value: '24px' })
    cmd('set', { uid, prop: 'color', value: 'var(--brand)' })
    expect(style()).toContain(`[data-op-edit="${uid}"]`)
    expect(style()).toContain('padding-left: 24px !important;')
    expect(last()?.active?.values).toEqual({ 'padding-left': '24px', color: 'var(--brand)' })

    cmd('undo', { uid })
    expect(style()).not.toContain('color:')
    cmd('reset', { uid })
    expect(style()).toBe('')
    expect(last()?.active?.history).toBe(0)
  })

  it('ignores commands that do not come from the parent window, and properties outside the list', () => {
    const p = document.getElementById('t')!
    page.__operatorEdit!.select(p, { selector: '#t' })
    const uid = p.getAttribute('data-op-edit')!
    window.dispatchEvent(new MessageEvent('message', { data: { [EDIT_CMD_TAG]: 'set', uid, prop: 'width', value: '1px' }, source: null }))
    cmd('set', { uid, prop: 'display', value: 'none' })
    expect(style()).toBe('')
  })

  it('reset all removes every rule and every tag', () => {
    const p = document.getElementById('t')!, b = document.querySelector('b')!
    page.__operatorEdit!.select(p, { selector: '#t' })
    cmd('set', { prop: 'width', value: '10px' })
    page.__operatorEdit!.select(b, { selector: 'b' })
    cmd('set', { prop: 'width', value: '20px' })
    expect(last()?.count).toBe(2)
    cmd('resetAll')
    expect(style()).toBe('')
    expect(document.querySelector('[data-op-edit]')).toBeNull()
    expect(last()?.active).toBeNull()
  })

  it('re-tags an element HMR replaced, so its rule applies to the new node', async () => {
    const p = document.getElementById('t')!
    page.__operatorEdit!.select(p, { selector: '#t' })
    const uid = p.getAttribute('data-op-edit')!
    cmd('set', { uid, prop: 'padding-left', value: '30px' })
    const fresh = document.createElement('p')
    fresh.id = 't'
    p.replaceWith(fresh)
    await new Promise((r) => setTimeout(r, 50))
    expect(fresh.getAttribute('data-op-edit')).toBe(uid)
  })
})
