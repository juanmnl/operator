// The CSS controls' pure functions, as source for the Preview page (src/shared/preview-edit-page.js reads
// them from `window.__operatorEditFns`). Each is self-contained by contract (see
// src/shared/preview-edit.ts), which is what makes `String(fn)` a working copy.
import { editRules, retagEdits, normalizeColor, matchToken, sourceFromDebugStack } from '../../../src/shared/preview-edit'

export const EDIT_FNS_JS = `
;window.__operatorEditFns = {
  editRules: ${String(editRules)},
  retagEdits: ${String(retagEdits)},
  normalizeColor: ${String(normalizeColor)},
  matchToken: ${String(matchToken)},
  sourceFromDebugStack: ${String(sourceFromDebugStack)},
};
`
