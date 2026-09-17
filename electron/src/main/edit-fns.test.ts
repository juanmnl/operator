import { describe, it, expect } from 'vitest'
import { EDIT_FNS_JS } from './edit-fns'
import { editRules, retagEdits, normalizeColor, matchToken, sourceFromDebugStack } from '../../../src/shared/preview-edit'

type Fns = {
  editRules: typeof editRules; retagEdits: typeof retagEdits; normalizeColor: typeof normalizeColor
  matchToken: typeof matchToken; sourceFromDebugStack: typeof sourceFromDebugStack
}

// The page gets these as SOURCE. A function that reached for an import or a module constant would
// compile here and throw inside the page.
describe('EDIT_FNS_JS', () => {
  it('defines working copies of the edit functions in a page that has nothing else', () => {
    const page: { __operatorEditFns?: Fns } = {}
    new Function('window', EDIT_FNS_JS)(page)
    const f = page.__operatorEditFns!
    const edits = [{ uid: 'e1', values: { 'padding-left': '4px', color: '#fff' } }]
    expect(f.editRules(edits)).toBe(editRules(edits))
    expect(f.normalizeColor('#ABC')).toBe(normalizeColor('#ABC'))
    const tokens = [{ name: '--a', value: 'rgb(170, 187, 204)' }]
    expect(f.matchToken('#abc', tokens)).toBe('--a')
    const stack = 'Error\n    at X (http://localhost:5173/src/X.tsx?t=1:3:4)'
    expect(f.sourceFromDebugStack(stack)).toBe(sourceFromDebugStack(stack))
    expect(typeof f.retagEdits).toBe('function')
  })
})
