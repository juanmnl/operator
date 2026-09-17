// CSS CONTROLS IN PREVIEW INSPECT (v1): the pure half.
//
// Design: dev/results/preview-css-controls-v1-2026-09-17.md (from preview-css-controls-research
// 'Recommended scope' v1). After an Inspect pick, a controls panel under the stage edits the picked
// element live: margin/padding per side, width/height, background/text/border colour with token snap,
// radius, opacity. Edits are applied as rules in ONE owned <style id="__op_edits"> on
// `[data-op-edit="<uid>"]`, never as inline style, so a re-render that rewrites `style` does not wipe
// them and app CSS loses to `!important`. HMR remounts drop the attribute; `retagEdits` finds the
// element again by its stored selector.
//
// SELF-CONTAINED FUNCTIONS. `editRules`, `retagEdits`, `normalizeColor` and `matchToken` are also run
// INSIDE the previewed page, given as source (`String(fn)`, electron/src/main/edit-fns.ts), the same
// contract `layoutGrid` keeps. No imports, no module constants, no calls to other functions in this
// file. A test runs each stringified copy.

/** The properties the v1 controls write, in panel order. The allow-list for rules too. */
export const EDIT_PROPS = [
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'width', 'height',
  'background-color', 'color', 'border-color',
  'border-radius', 'opacity',
] as const
export type EditProp = (typeof EDIT_PROPS)[number]

export interface EditRecord {
  uid: string
  /** Property → the value the controls set. Absent = untouched. */
  values: Partial<Record<string, string>>
}

/** The owned stylesheet's text: one rule per edited element, declarations `!important` so the app's
 *  own CSS (any specificity, inline style) does not win. Properties outside the allow-list and values
 *  that could close the rule or open another (`;`, `{`, `}`, `<`, `\`, a newline) are dropped. A uid is
 *  reduced to `[A-Za-z0-9_-]`, so it cannot break out of the attribute selector. */
export function editRules(edits: ReadonlyArray<{ uid: string; values: Partial<Record<string, string>> }>): string {
  const allowed = [
    'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'width', 'height', 'background-color', 'color', 'border-color', 'border-radius', 'opacity',
  ]
  const out: string[] = []
  for (const e of edits) {
    const uid = String(e.uid).replace(/[^A-Za-z0-9_-]/g, '')
    if (!uid) continue
    const decls: string[] = []
    for (const prop of allowed) {
      const raw = e.values[prop]
      if (raw == null) continue
      const v = String(raw).trim()
      if (!v || /[;{}<\\\n\r]/.test(v) || /!important/i.test(v)) continue
      decls.push(`  ${prop}: ${v} !important;`)
    }
    if (decls.length) out.push(`[data-op-edit="${uid}"] {\n${decls.join('\n')}\n}`)
  }
  return out.join('\n')
}

/** A computed colour → `rgb(r, g, b)` or `rgba(r, g, b, a)` with a trimmed alpha; `#rgb`/`#rrggbb`
 *  (and `#rrggbbaa`) accepted too. Anything else is returned trimmed and lower-cased, so two equal
 *  strings still compare equal. */
export function normalizeColor(css: string): string {
  const s = String(css || '').trim().toLowerCase()
  const hex = /^#([0-9a-f]{3,8})$/.exec(s)
  if (hex) {
    let h = hex[1]
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('')
    if (h.length !== 6 && h.length !== 8) return s
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16)
    if (h.length === 8) {
      const a = Math.round((n(6) / 255) * 1000) / 1000
      return a >= 1 ? `rgb(${n(0)}, ${n(2)}, ${n(4)})` : `rgba(${n(0)}, ${n(2)}, ${n(4)}, ${a})`
    }
    return `rgb(${n(0)}, ${n(2)}, ${n(4)})`
  }
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s)
  if (m) {
    const c = [m[1], m[2], m[3]].map((x) => Math.round(Number(x)))
    let a = m[4] == null ? 1 : m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4])
    a = Math.round(a * 1000) / 1000
    return a >= 1 ? `rgb(${c[0]}, ${c[1]}, ${c[2]})` : `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`
  }
  return s
}

/** The custom property whose resolved value is this colour, or null. `tokens` values are resolved
 *  colours as the page computes them. First declared wins, so `--brand` beats an alias declared
 *  after it. Transparent never matches: every unset token would claim it. */
export function matchToken(value: string, tokens: ReadonlyArray<{ name: string; value: string }>): string | null {
  const norm = (css: string): string => {
    const s = String(css || '').trim().toLowerCase()
    const hex = /^#([0-9a-f]{3,8})$/.exec(s)
    if (hex) {
      let h = hex[1]
      if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('')
      const n = (i: number) => parseInt(h.slice(i, i + 2), 16)
      if (h.length === 6) return `rgb(${n(0)}, ${n(2)}, ${n(4)})`
      if (h.length === 8) {
        const a = Math.round((n(6) / 255) * 1000) / 1000
        return a >= 1 ? `rgb(${n(0)}, ${n(2)}, ${n(4)})` : `rgba(${n(0)}, ${n(2)}, ${n(4)}, ${a})`
      }
      return s
    }
    const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s)
    if (!m) return s
    const c = [m[1], m[2], m[3]].map((x) => Math.round(Number(x)))
    let a = m[4] == null ? 1 : m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4])
    a = Math.round(a * 1000) / 1000
    return a >= 1 ? `rgb(${c[0]}, ${c[1]}, ${c[2]})` : `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`
  }
  const want = norm(value)
  if (!want || want === 'transparent' || want === 'rgba(0, 0, 0, 0)') return null
  for (const t of tokens) {
    if (norm(t.value) === want) return t.name
  }
  return null
}

/** HMR RE-TAG. A Fast Refresh remount replaces the element, and the `data-op-edit` attribute (not in
 *  the component's JSX) goes with it. For each edit with no tagged element in the document, find the
 *  element by its stored selector and tag it again, unless that element already carries another
 *  edit's uid. Returns the uids re-tagged. */
export function retagEdits(doc: Document, edits: ReadonlyArray<{ uid: string; selector: string }>): string[] {
  const done: string[] = []
  for (const e of edits) {
    const uid = String(e.uid).replace(/[^A-Za-z0-9_-]/g, '')
    if (!uid || !e.selector) continue
    if (doc.querySelector(`[data-op-edit="${uid}"]`)) continue
    let el: Element | null = null
    try { el = doc.querySelector(e.selector) } catch { el = null }
    if (!el || el.hasAttribute('data-op-edit')) continue
    el.setAttribute('data-op-edit', uid)
    done.push(uid)
  }
  return done
}

// ── renderer side (not injected) ────────────────────────────────────────────────────────────────

export interface EditChange {
  property: string
  before: string
  after: string
  /** The custom property the new value matches, by name. */
  token: string | null
}

/** THE DIFF: only the properties the controls touched, and only where the computed value actually
 *  moved. `before` is the computed value at pick time, `after` the computed value now. Colour
 *  properties are compared normalised and matched to tokens. Panel order. */
export function diffChanges(
  before: Partial<Record<string, string>>,
  touched: Partial<Record<string, string>>,
  after: Partial<Record<string, string>>,
  tokens: ReadonlyArray<{ name: string; value: string }> = [],
): EditChange[] {
  const colour = new Set(['background-color', 'color', 'border-color'])
  const out: EditChange[] = []
  for (const prop of EDIT_PROPS) {
    if (touched[prop] == null) continue
    const b = (before[prop] ?? '').trim()
    const a = (after[prop] ?? touched[prop] ?? '').trim()
    const same = colour.has(prop) ? normalizeColor(a) === normalizeColor(b) : a === b
    if (same) continue
    out.push({ property: prop, before: b, after: a, token: colour.has(prop) ? matchToken(a, tokens) : null })
  }
  return out
}

/** What React 19 still carries for a source location. `_debugSource` is gone there; `_debugStack` is
 *  an Error whose stack has the JSX call site as a dev-server URL. Returns the project path
 *  (`src/Pricing.tsx`) with no line: the line in that stack is of the TRANSFORMED module, not the
 *  file, so quoting it would point at the wrong line. Frames inside dependencies are skipped. */
export function sourceFromDebugStack(stack: string | null | undefined): string | null {
  if (!stack) return null
  for (const line of String(stack).split('\n')) {
    const m = /(https?:\/\/[^\s)]+?):\d+:\d+/.exec(line)
    if (!m) continue
    let path: string
    try { path = new URL(m[1]).pathname } catch { continue }
    if (/\/node_modules\/|\/\.vite\/|\/@react-refresh|\/@vite\//.test(path)) continue
    return path.replace(/^\/+/, '')
  }
  return null
}

export interface EditPayload {
  label: string
  component: string | null
  /** `file:line` (React ≤18 `_debugSource`), a file with no line (React 19 fallback), or null. */
  source: string | null
  selector: string
  route: string
  scope: 'element'
  changes: EditChange[]
}

/** The message sent to the lane. Written for an agent that has to change SOURCE: where, what moved
 *  from what to what, and the token to use when one matches. */
export function composeEditMessage(p: EditPayload, shots: { before?: string | null; after?: string | null } = {}): string {
  const where = p.source ? `${p.component || p.label} @ ${p.source}` : `${p.component || p.label} (${p.selector})`
  const lines = p.changes.map((c) => {
    const to = c.token ? `var(${c.token})` : c.after
    const raw = c.token ? ` (${c.after})` : ''
    return `- ${c.property}: ${c.before || '(unset)'} → ${to}${raw}`
  })
  const out = [
    `CSS changes made live in Preview on ${p.route || '/'}, scope: this element only.`,
    `Element: ${where}`,
    ...(p.source ? [`Selector: ${p.selector}`] : []),
    '',
    ...lines,
    '',
    'Apply these in the source (use the named tokens where given), so they survive a reload.',
  ]
  if (shots.before) out.push(`Before: ${shots.before}`)
  if (shots.after) out.push(`After: ${shots.after}`)
  return out.join('\n')
}

/** Channel values for `<input type="color">`, from a computed colour. `#000000` when unreadable. */
export function colorInputValue(css: string): string {
  const m = /^rgba?\((\d+), (\d+), (\d+)/.exec(normalizeColor(css))
  if (!m) return '#000000'
  return '#' + [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('')
}

/** A stepper's next value: `12px` + 1 → `13px`. Unitless numbers stay unitless (opacity), `auto` and
 *  anything unparseable start from 0px. Never below `min`. */
export function stepValue(current: string, delta: number, min = -Infinity): string {
  const m = /^(-?[\d.]+)([a-z%]*)$/i.exec(String(current).trim())
  if (!m) return `${Math.max(min, delta)}px`
  const n = Math.round((Number(m[1]) + delta) * 100) / 100
  return `${Math.max(min, n)}${m[2]}`
}

/** The page → renderer message tag for edit state, and the renderer → page command tag. Separate
 *  from preview-frame's pick/anchor tag so neither parser has to know the other. */
export const EDIT_STATE_TAG = '__operatorEdit'
export const EDIT_CMD_TAG = '__operatorEditCmd'

export interface EditState {
  active: null | {
    uid: string
    label: string
    component: string | null
    source: string | null
    selector: string
    route: string
    before: Partial<Record<string, string>>
    values: Partial<Record<string, string>>
    current: Partial<Record<string, string>> | null
    history: number
    box: { x: number; y: number; w: number; h: number } | null
  }
  count: number
  tokens: Array<{ name: string; value: string }>
}

/** Parse an edit-state message, or null. */
export function editStateMessage(data: unknown): EditState | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (d[EDIT_STATE_TAG] !== 'state' || typeof d.data !== 'string') return null
  try {
    const s = JSON.parse(d.data) as EditState
    return s && typeof s === 'object' && Array.isArray(s.tokens) ? s : null
  } catch { return null }
}
