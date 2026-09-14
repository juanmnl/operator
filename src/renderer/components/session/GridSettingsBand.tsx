import { useEffect, useRef, useState } from 'react'
import {
  layoutGrid, applyGridPreset, editGridField, parseGridField, stepGridField, formatColumnWidth,
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
        style={{
          width: 44, boxSizing: 'border-box', padding: '2px 5px', textAlign: 'right',
          fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace", fontSize: 11, fontVariantNumeric: 'tabular-nums',
          color: 'var(--fg)', background: 'var(--overlay-subtle)',
          border: '1px solid transparent', borderRadius: 4, outline: 'none',
        }}
      />
    </label>
  )
}

/** Same focus edge as the Preview's path field: an edge change on a 4px radius, no ring. */
const FOCUS_EDGE = 'color-mix(in srgb, var(--accent) 45%, var(--border))'

const group: React.CSSProperties = {
  display: 'flex', alignItems: 'center', height: PANEL_SUBHEAD_H, flexShrink: 0,
}
