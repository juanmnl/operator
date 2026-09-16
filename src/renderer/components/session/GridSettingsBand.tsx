import { useEffect, useRef, useState } from 'react'
import {
  layoutGrid, applyGridPreset, editGridField, parseGridField, stepGridField, formatColumnWidth,
  GRID_SWATCHES, GRID_FILLS, parseGridColor, withGridColor, withGridFill,
  type GridSpec, type GridField, type GridPresetId,
} from '../../../shared/layout-grid'
import { PANEL_SUBHEAD_H } from '../../lib/chrome'
import { CONTROL_OFF_INK } from '../../lib/preview-toolbar'

// The layout grid's settings: a band UNDER the Preview's tools row. A band and not a popover,
// because you edit a gutter while watching the columns move, so it has to sit beside the page. It
// pushes the stage down instead of covering it, which also keeps it clear of the native inspect
// view (nothing Operator draws may overlap the stage while that view is up). It wraps to more
// lines when the preview is narrow; every group is one band high, so each line is 30px.

const PRESET_SEGMENTS: { id: GridPresetId | 'custom'; label: string; title: string }[] = [
  { id: 'auto', label: 'Auto', title: '4 columns below 600px page width, 8 from 600, 12 from 840' },
  { id: '4', label: '4', title: '4 columns · 16 gutter · 16 margin' },
  { id: '8', label: '8', title: '8 columns · 24 gutter · 32 margin' },
  { id: '12', label: '12', title: '12 columns · 24 gutter · 32 margin' },
  { id: 'custom', label: 'Custom', title: 'Your own columns, gutter and margin' },
]

const FIELDS: { field: GridField; label: string }[] = [
  { field: 'columns', label: 'Columns' },
  { field: 'gutter', label: 'Gutter' },
  { field: 'margin', label: 'Margin' },
  { field: 'maxWidth', label: 'Max width' },
]

export function GridSettingsBand({ spec, pageW, savedTo, onChange, onDone }: {
  spec: GridSpec
  /** The page's own width in CSS px (the device preset's, not the panel's). Auto resolves
   *  against it. */
  pageW: number
  /** The project the spec is saved to; null when the session has no project and edits live only
   *  in memory. */
  savedTo: string | null
  onChange: (spec: GridSpec) => void
  onDone: () => void
}) {
  const layout = layoutGrid(spec, pageW)
  // With Auto selected the fields show what Auto resolved for this page width.
  const values: Record<GridField, number | null> = {
    columns: layout.columns, gutter: layout.gutter, margin: layout.margin, maxWidth: spec.maxWidth,
  }
  return (
    <div data-no-drag style={{
      display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 14, rowGap: 0,
      padding: '0 8px 0 12px', borderTop: '1px solid var(--border)', boxSizing: 'border-box',
    }}>
      <span style={group}>
        <span style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 6, padding: 1 }}>
          {PRESET_SEGMENTS.map((s) => {
            const on = spec.preset === s.id
            return (
              <button
                key={s.id}
                onClick={() => onChange(s.id === 'custom'
                  ? { ...spec, preset: 'custom', columns: layout.columns, gutter: layout.gutter, margin: layout.margin }
                  : applyGridPreset(spec, s.id))}
                title={s.title}
                style={{
                  height: 20, padding: '0 7px', border: 'none', borderRadius: 5, cursor: 'pointer', outline: 'none',
                  fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 600,
                  background: on ? 'var(--overlay-subtle)' : 'transparent',
                  color: on ? 'var(--accent)' : CONTROL_OFF_INK,
                }}
              >{s.label}</button>
            )
          })}
        </span>
      </span>

      <span style={{ ...group, gap: 10 }}>
        {FIELDS.map(({ field, label }) => (
          <NumberField
            key={field}
            field={field}
            label={label}
            value={values[field]}
            onCommit={(v) => onChange(editGridField(spec, pageW, field, v))}
          />
        ))}
      </span>

      <ColorGroup spec={spec} onChange={onChange} />

      {/* The column width is the number people tune for, so it sits in this row. */}
      <span style={{ ...group, gap: 6, fontFamily: 'var(--font-mono)', fontSize: 10, whiteSpace: 'nowrap' }}>
        <span style={{ color: 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}>
          {layout.cols.length > 0 ? `${formatColumnWidth(layout.colW)} columns` : 'Columns don’t fit at this width'}
        </span>
        {layout.autoColumns != null && <span style={{ color: 'var(--fg-muted)' }}>Auto → {layout.autoColumns}</span>}
        <span style={{ color: 'var(--fg-muted)' }}>
          · {savedTo ? `Saved to ${savedTo}` : 'Not saved — this session has no project'}
        </span>
      </span>

      <span style={{ ...group, marginLeft: 'auto' }}>
        <button
          onClick={onDone}
          title="Close grid settings"
          style={{
            fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 600, padding: '2px 6px',
            border: 'none', borderRadius: 4, background: 'transparent', cursor: 'pointer', outline: 'none',
            color: CONTROL_OFF_INK,
          }}
        >Done</button>
      </span>
    </div>
  )
}

/** One field. Typing commits on Enter or blur; invalid input reverts on blur; Esc reverts. ↑/↓
 *  step ±1 (±8 with ⇧) and commit at once, so the columns move while you hold the key. */
function NumberField({ field, label, value, onCommit }: {
  field: GridField
  label: string
  value: number | null
  onCommit: (value: number | null) => void
}) {
  const shown = value == null ? '' : String(value)
  const [text, setText] = useState(shown)
  const [focused, setFocused] = useState(false)
  // Follow the value while nobody is typing: a preset, a step, or Auto moving with the page width
  // all change it from outside.
  useEffect(() => { if (!focused) setText(shown) }, [shown, focused])
  // Esc blurs the field, and the blur must not then commit what Esc just abandoned.
  const revertingRef = useRef(false)

  const commit = (raw: string) => {
    const v = parseGridField(field, raw)
    if (v === undefined) { setText(shown); return }
    if (v !== value) onCommit(v)
  }

  return (
    <label style={{
      display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap',
      fontFamily: 'var(--font-body)', fontSize: 10, color: CONTROL_OFF_INK,
    }}>
      {label}
      <input
        value={text}
        inputMode="numeric"
        spellCheck={false}
        placeholder={field === 'maxWidth' ? 'none' : undefined}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => { setFocused(true); e.currentTarget.style.borderColor = FOCUS_EDGE }}
        onBlur={(e) => {
          setFocused(false)
          e.currentTarget.style.borderColor = 'transparent'
          if (revertingRef.current) { revertingRef.current = false; return }
          commit(e.currentTarget.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            const next = stepGridField(field, value, (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 8 : 1))
            setText(next == null ? '' : String(next))
            if (next !== value) onCommit(next)
          } else if (e.key === 'Enter') {
            commit(e.currentTarget.value)
          } else if (e.key === 'Escape') {
            revertingRef.current = true
            setText(shown)
            e.currentTarget.blur()
          }
        }}
        style={{ ...inputBox, width: 44, textAlign: 'right' }}
      />
    </label>
  )
}

/** THE GRID'S COLOUR: Theme (the palette's `--grid`, the default), five fixed swatches, a custom
 *  colour (native picker plus a hex field), and the fill strength.
 *
 *  Selection is a 2px accent bar under the swatch, drawn with a changing BACKGROUND. The swatch's
 *  own border is static: a radiused element whose border colour changes is the WKWebView freeze
 *  this app already paid for. */
function ColorGroup({ spec, onChange }: { spec: GridSpec; onChange: (spec: GridSpec) => void }) {
  const custom = spec.color != null && !GRID_SWATCHES.some((s) => s.color === spec.color)
  return (
    <span style={{ ...group, gap: 10 }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-body)', fontSize: 10, color: CONTROL_OFF_INK, whiteSpace: 'nowrap' }}>
        Colour
        <span role="group" aria-label="Grid colour" style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Swatch
            fill="var(--grid)" on={spec.color == null} name="Theme"
            title="Theme colour (the palette’s grid colour)"
            onPick={() => onChange(withGridColor(spec, undefined))}
          />
          {GRID_SWATCHES.map((sw) => (
            <Swatch
              key={sw.color} fill={sw.color} on={spec.color === sw.color} name={sw.name} title={`${sw.name} ${sw.color}`}
              onPick={() => onChange(withGridColor(spec, sw.color))}
            />
          ))}
          <CustomSwatch spec={spec} on={custom} onChange={onChange} />
        </span>
        <HexField value={spec.color ?? null} onCommit={(c) => onChange(withGridColor(spec, c))} />
      </span>

      <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-body)', fontSize: 10, color: CONTROL_OFF_INK, whiteSpace: 'nowrap' }}>
        Fill
        <span style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 6, padding: 1 }}>
          {GRID_FILLS.map((f) => {
            const on = (spec.fill ?? 10) === f
            return (
              <button
                key={f}
                onClick={() => onChange(withGridFill(spec, f))}
                aria-pressed={on}
                title={f === 10 ? 'Column fill 10% (default)' : `Column fill ${f}%, for busy pages`}
                style={{
                  height: 20, padding: '0 6px', border: 'none', borderRadius: 5, cursor: 'pointer', outline: 'none',
                  fontFamily: 'var(--font-mono)', fontSize: 10, fontVariantNumeric: 'tabular-nums',
                  background: on ? 'var(--overlay-subtle)' : 'transparent',
                  color: on ? 'var(--accent)' : CONTROL_OFF_INK,
                }}
              >{f}%</button>
            )
          })}
        </span>
      </span>
    </span>
  )
}

const SWATCH = 12

/** The mark under a selected swatch. */
function SelectedBar({ on }: { on: boolean }) {
  return <span aria-hidden style={{ width: SWATCH - 2, height: 2, borderRadius: 1, background: on ? 'var(--accent)' : 'transparent' }} />
}

const swatchBtn: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, padding: '3px 2px 0',
  border: 'none', background: 'transparent', cursor: 'pointer', outline: 'none',
}

const swatchChip = (fill: string): React.CSSProperties => ({
  width: SWATCH, height: SWATCH, boxSizing: 'border-box', borderRadius: 3,
  border: '1px solid var(--border)', background: fill,
})

function Swatch({ fill, on, name, title, onPick }: { fill: string; on: boolean; name: string; title: string; onPick: () => void }) {
  return (
    <button onClick={onPick} title={title} aria-label={name} aria-pressed={on} style={swatchBtn}>
      <span style={swatchChip(fill)} />
      <SelectedBar on={on} />
    </button>
  )
}

/** The system colour picker, behind a swatch. It shows the custom colour once there is one, and a
 *  hue wheel before. Its `input` events apply live, like the ↑/↓ steps on the number fields. */
function CustomSwatch({ spec, on, onChange }: { spec: GridSpec; on: boolean; onChange: (spec: GridSpec) => void }) {
  const fill = on && spec.color
    ? spec.color
    : `conic-gradient(${[...GRID_SWATCHES, GRID_SWATCHES[0]].map((sw) => sw.color).join(', ')})`
  return (
    <label title="Custom colour" style={{ ...swatchBtn, position: 'relative' }}>
      <span style={swatchChip(fill)} />
      <SelectedBar on={on} />
      <input
        type="color"
        aria-label="Custom grid colour"
        value={spec.color ?? GRID_SWATCHES[0].color}
        onChange={(e) => {
          const c = parseGridColor(e.currentTarget.value)
          if (c && c !== spec.color) onChange(withGridColor(spec, c))
        }}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, cursor: 'pointer', border: 'none', padding: 0 }}
      />
    </label>
  )
}

/** The colour as hex. Empty means Theme. Commits on Enter or blur; invalid input reverts; Esc
 *  reverts. Accepts `#rgb` and a missing `#`. */
function HexField({ value, onCommit }: { value: string | null; onCommit: (color: string | undefined) => void }) {
  const shown = value ?? ''
  const [text, setText] = useState(shown)
  const [focused, setFocused] = useState(false)
  useEffect(() => { if (!focused) setText(shown) }, [shown, focused])
  const revertingRef = useRef(false)

  const commit = (raw: string) => {
    if (raw.trim() === '') { if (value != null) onCommit(undefined); return }
    const c = parseGridColor(raw)
    if (!c) { setText(shown); return }
    if (c !== value) onCommit(c)
    else setText(shown)
  }

  return (
    <input
      value={text}
      aria-label="Grid colour hex"
      spellCheck={false}
      placeholder="theme"
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => { setFocused(true); e.currentTarget.style.borderColor = FOCUS_EDGE }}
      onBlur={(e) => {
        setFocused(false)
        e.currentTarget.style.borderColor = 'transparent'
        if (revertingRef.current) { revertingRef.current = false; return }
        commit(e.currentTarget.value)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit(e.currentTarget.value)
        else if (e.key === 'Escape') { revertingRef.current = true; setText(shown); e.currentTarget.blur() }
      }}
      style={{ ...inputBox, width: 64, textAlign: 'left' }}
    />
  )
}

/** Same focus edge as the Preview's path field: an edge change on a 4px radius, no ring. */
const FOCUS_EDGE = 'color-mix(in srgb, var(--accent) 45%, var(--border))'

const group: React.CSSProperties = {
  display: 'flex', alignItems: 'center', height: PANEL_SUBHEAD_H, flexShrink: 0,
}

const inputBox: React.CSSProperties = {
  boxSizing: 'border-box', padding: '2px 5px',
  fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace", fontSize: 11, fontVariantNumeric: 'tabular-nums',
  color: 'var(--fg)', background: 'var(--overlay-subtle)',
  border: '1px solid transparent', borderRadius: 4, outline: 'none',
}
