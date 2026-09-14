// The Preview's toolbar: which layout it takes at a measured width, and the labels that change
// with it. Pure, so the thresholds are tested without mounting AppPreviewPanel.

/** `one`: address and tools share a row. `two`: tools get their own row. `narrow`: the tools row
 *  may wrap to a third line, and the origin chip drops `localhost`. */
export type ToolbarTier = 'one' | 'two' | 'narrow'

/** The one-row bar measures about 840px with a 160px path field. */
export const ONE_ROW_MIN_W = 880
/** The tools row alone measures about 460px. */
export const TWO_ROW_MIN_W = 520

/** Chosen from the preview root's measured width, not from which slot it is in: a narrow main
 *  view (sidebar open, wide side panel) gets the same bar as the panel. */
export function toolbarTier(width: number): ToolbarTier {
  if (width >= ONE_ROW_MIN_W) return 'one'
  if (width >= TWO_ROW_MIN_W) return 'two'
  return 'narrow'
}

/** What the origin chip says. An external target shows its host. Narrow drops `localhost` but
 *  never the port, because the port is what identifies the server. */
export function originChipLabel(url: string | null | undefined, port: number | null | undefined, tier: ToolbarTier): string {
  if (url) { try { return new URL(url).host } catch { return url } }
  if (port == null) return 'no server'
  return tier === 'narrow' ? `:${port}` : `localhost:${port}`
}

/** `768 · 62%` when a device preset is wider than the stage and is scaled down to fit it; null
 *  otherwise (Fit, a preset that fits, or a stage not measured yet). */
export function scaleReadout(preset: 'fit' | number, stageW: number): string | null {
  if (preset === 'fit' || stageW <= 0 || preset <= stageW) return null
  return `${preset} · ${Math.round((stageW / preset) * 100)}%`
}

/** Off-state ink for the Preview's text controls (presets, pointer mode, overlays, the grid
 *  settings band). `--fg-muted` at 9.5–10px is below the 4.5:1 control-label floor on the light
 *  palettes. */
export const CONTROL_OFF_INK = 'color-mix(in srgb, var(--fg) 72%, transparent)'

/** Exactly one pointer mode. Interact: clicks reach the app. Annotate: pin/box notes. Inspect:
 *  click an element to compose a note about it (the native view). */
export type PointerMode = 'interact' | 'annotate' | 'inspect'

/** The mode the two flags spell. If both are briefly true (⌘E turned Annotate on while Inspect
 *  was up, before the component turns Inspect off), Annotate is the one that stays. */
export function pointerMode(annotate: boolean, inspecting: boolean): PointerMode {
  if (annotate) return 'annotate'
  return inspecting ? 'inspect' : 'interact'
}
