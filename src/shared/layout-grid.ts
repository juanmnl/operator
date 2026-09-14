// The layout grid laid over the Preview: its geometry, its presets, and the rules for editing a
// spec. In `src/shared` because two hosts draw it: the renderer over the iframe today, and a
// script injected into the native inspect view's page later. Pure.
import type { GridSpec } from './types'

export type { GridSpec }

/** What a project that never set a grid gets: Auto. The fields are where Custom starts. */
export const DEFAULT_GRID_SPEC: GridSpec = { preset: 'auto', columns: 12, gutter: 24, margin: 32, maxWidth: null }

export interface GridColumn { left: number; width: number }

export interface GridLayout {
  columns: number
  gutter: number
  margin: number
  /** The column count Auto picked for this page width; null when the spec is not Auto. */
  autoColumns: 4 | 8 | 12 | null
  /** The container: `maxWidth` wide (or the whole page), centred. */
  containerLeft: number
  containerW: number
  /** `maxWidth` is narrower than the page, so the container's edges are drawn. */
  clamped: boolean
  x0: number
  contentW: number
  colW: number
  /** Empty when the columns do not fit (`colW <= 0`): nothing is drawn. */
  cols: GridColumn[]
}

/** THE GEOMETRY. The same box as CSS `max-width; margin-inline: auto; padding-inline: <margin>`,
 *  which is how most app containers are written, so the columns land on real content edges:
 *
 *    containerW = maxWidth ? min(pageW, maxWidth) : pageW
 *    x0         = (pageW − containerW) / 2 + margin
 *    contentW   = containerW − 2 × margin
 *    colW       = (contentW − (columns − 1) × gutter) / columns
 *    column i   = { left: x0 + i × (colW + gutter), width: colW }
 *
 *  Auto resolves columns, gutter and margin from the page width at Material 3's window-size
 *  breakpoints (4 below 600, 8 from 600, 12 from 840), so the device presets move it. Its values
 *  are written out here rather than read from `GRID_PRESETS`, for the reason below; a test holds
 *  the two in agreement.
 *
 *  SELF-CONTAINED ON PURPOSE: no runtime imports, no module constants, no calls out. The injected
 *  script can then be given `String(layoutGrid)` and run the renderer's own code, and a test
 *  checks that the stringified function still works. Keep it that way. */
export function layoutGrid(spec: GridSpec, pageW: number): GridLayout {
  const auto = spec.preset === 'auto'
  const tier: 4 | 8 | 12 = pageW >= 840 ? 12 : pageW >= 600 ? 8 : 4
  const columns = auto ? tier : spec.columns
  const gutter = auto ? (tier === 4 ? 16 : 24) : spec.gutter
  const margin = auto ? (tier === 4 ? 16 : 32) : spec.margin
  const containerW = spec.maxWidth ? Math.min(pageW, spec.maxWidth) : pageW
  const containerLeft = (pageW - containerW) / 2
  const x0 = containerLeft + margin
  const contentW = containerW - 2 * margin
  const colW = (contentW - (columns - 1) * gutter) / columns
  const cols: GridColumn[] = []
  if (colW > 0) {
    for (let i = 0; i < columns; i++) cols.push({ left: x0 + i * (colW + gutter), width: colW })
  }
  return {
    columns, gutter, margin, autoColumns: auto ? tier : null,
    containerLeft, containerW, clamped: containerW < pageW, x0, contentW, colW, cols,
  }
}

export type GridPresetId = 'auto' | '4' | '8' | '12'

/** The fixed presets. Picking one overwrites columns, gutter and margin. */
export const GRID_PRESETS: Record<'4' | '8' | '12', { columns: number; gutter: number; margin: number }> = {
  '4': { columns: 4, gutter: 16, margin: 16 },
  '8': { columns: 8, gutter: 24, margin: 32 },
  '12': { columns: 12, gutter: 24, margin: 32 },
}

/** Pick a preset. `maxWidth` is kept: it applies across every preset, Auto's tiers included. */
export function applyGridPreset(spec: GridSpec, preset: GridPresetId): GridSpec {
  if (preset === 'auto') return { ...spec, preset: 'auto' }
  return { ...spec, preset, ...GRID_PRESETS[preset] }
}

export type GridField = 'columns' | 'gutter' | 'margin' | 'maxWidth'

/** Accepted range per field, in whole CSS px. `maxWidth` has a floor only; empty means none. */
export const GRID_FIELD_BOUNDS: Record<GridField, { min: number; max: number }> = {
  columns: { min: 1, max: 24 },
  gutter: { min: 0, max: 200 },
  margin: { min: 0, max: 400 },
  maxWidth: { min: 240, max: Infinity },
}

/** What the user typed, parsed. `undefined` = invalid, so the field reverts; `null` = no max
 *  width (an empty Max width field). */
export function parseGridField(field: GridField, raw: string): number | null | undefined {
  const t = raw.trim()
  if (field === 'maxWidth' && t === '') return null
  if (!/^\d+$/.test(t)) return undefined
  const v = Number(t)
  const b = GRID_FIELD_BOUNDS[field]
  return v >= b.min && v <= b.max ? v : undefined
}

/** ↑/↓ on a field: `delta` is ±1, or ±8 with ⇧. Clamped to the field's range; no max width
 *  stays none. */
export function stepGridField(field: GridField, value: number | null, delta: number): number | null {
  if (value == null) return null
  const b = GRID_FIELD_BOUNDS[field]
  return Math.min(b.max, Math.max(b.min, value + delta))
}

/** Set one field. Columns, gutter or margin make the spec Custom, starting from the values in
 *  effect on this page, so editing the gutter of an Auto grid on a 768 page keeps its 8 columns.
 *  Max width leaves the preset alone, because no preset sets it. */
export function editGridField(spec: GridSpec, pageW: number, field: GridField, value: number | null): GridSpec {
  if (field === 'maxWidth') return { ...spec, maxWidth: value }
  if (value == null) return spec
  const now = layoutGrid(spec, pageW)
  return { preset: 'custom', columns: now.columns, gutter: now.gutter, margin: now.margin, maxWidth: spec.maxWidth, [field]: value }
}

/** A stored spec, checked. `projects.json` outlives builds and can be edited by hand; anything
 *  that is not a valid spec reads as absent, which means Auto. */
export function coerceGridSpec(raw: unknown): GridSpec | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const inRange = (field: GridField, v: unknown) => {
    const b = GRID_FIELD_BOUNDS[field]
    return typeof v === 'number' && Number.isInteger(v) && v >= b.min && v <= b.max
  }
  const presets: GridSpec['preset'][] = ['auto', '4', '8', '12', 'custom']
  if (!presets.includes(r.preset as GridSpec['preset'])) return undefined
  if (!inRange('columns', r.columns) || !inRange('gutter', r.gutter) || !inRange('margin', r.margin)) return undefined
  if (r.maxWidth != null && !inRange('maxWidth', r.maxWidth)) return undefined
  return {
    preset: r.preset as GridSpec['preset'],
    columns: r.columns as number,
    gutter: r.gutter as number,
    margin: r.margin as number,
    maxWidth: (r.maxWidth as number | null | undefined) ?? null,
  }
}

/** `72.67px`: at most two decimals, none when whole. */
export function formatColumnWidth(colW: number): string {
  return `${Number(colW.toFixed(2))}px`
}
