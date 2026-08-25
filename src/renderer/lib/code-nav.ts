// Deep links into Files — the URL scheme and the one routing rule, both pure.
//
// §4 of `dev/results/code-navigator-design.md`. The design is unusually direct about which half
// matters, and it is not the numbers:
//
//   > The principle B and C encode: a deep link never replaces the surface you clicked it in.
//   > Clicking a path in the transcript you are reading must not close that transcript.
//
// So the rule is written down here, tested before anything calls it, and the width thresholds are
// secondary vetoes applied afterwards rather than the primary decision.

/** Which surface a link came from. `elsewhere` is a task card, the palette, the sidebar — any
 *  source that is not itself one of the two Files placements. */
export type LinkOrigin = 'main' | 'panel' | 'elsewhere'
export type FileSurface = 'main' | 'panel'

export interface FilesTarget {
  /** Repo-relative, or absolute — the viewer resolves it against the root. */
  path: string
  line?: number
  endLine?: number
  root: 'lane' | 'project'
}

/** `operator://file/<path>[:line[:endLine]][?root=lane|project]`
 *
 *  PARSED BY HAND rather than with `new URL()`, and the reason is the path: a repo-relative path
 *  is not a valid URL path component once it contains anything `URL` wants to percent-decode, and
 *  round-tripping through `URL` mangles a filename containing `#` or `%`. The scheme is ours and
 *  its grammar is small enough to read directly.
 *
 *  THE `:line` AMBIGUITY IS REAL and is why the line suffix is matched from the END: a Windows
 *  path (`C:/x/y.ts`) and a filename containing a colon both put colons where the suffix looks
 *  like it could be. Anchoring on trailing `:digits` and requiring digits means `a:b.ts` stays a
 *  filename while `a.ts:60` is a line link.
 *
 *  Returns null for anything that is not one of our links — the canvas click handler branches on
 *  exactly that, and an over-eager parse would swallow ordinary `https://` links. */
export function parseFileHref(href: string): FilesTarget | null {
  if (!href.startsWith('operator://file/')) return null
  let rest = href.slice('operator://file/'.length)
  if (!rest) return null

  let root: 'lane' | 'project' = 'lane'
  const q = rest.indexOf('?')
  if (q >= 0) {
    const params = new URLSearchParams(rest.slice(q + 1))
    if (params.get('root') === 'project') root = 'project'
    rest = rest.slice(0, q)
  }

  let line: number | undefined
  let endLine: number | undefined
  // Two suffixes at most, taken from the right: `:60:74`, then `:60`.
  const two = /^(.*?):(\d+):(\d+)$/.exec(rest)
  const one = /^(.*?):(\d+)$/.exec(rest)
  if (two) {
    rest = two[1]
    line = Number(two[2])
    endLine = Number(two[3])
  } else if (one) {
    rest = one[1]
    line = Number(one[2])
  }
  if (!rest) return null
  // A backwards range is a caller bug, not a user's problem — normalise rather than refuse, so a
  // hunk header with its numbers swapped still lands somewhere sensible.
  if (line != null && endLine != null && endLine < line) [line, endLine] = [endLine, line]
  return { path: decodeURIComponent(rest), line, endLine, root }
}

/** The inverse, for the sources that construct links. */
export function buildFileHref(t: FilesTarget): string {
  const suffix = t.line == null ? '' : t.endLine == null ? `:${t.line}` : `:${t.line}:${t.endLine}`
  const query = t.root === 'project' ? '?root=project' : ''
  return `operator://file/${encodeURIComponent(t.path)}${suffix}${query}`
}

/** The width at which the main view can show the tree AND a full 100-column line:
 *  240 (SplitPane index) + 660 (≈100 columns at 6.6px/char for JetBrains Mono at 11px). */
export const MAIN_PREFERRED_W = 900
/** The same 100 columns without a tree. Below it the main view has no advantage over the panel. */
export const MAIN_MIN_W = 640
/** The panel's file-only floor, from §3's measured forms. */
export const PANEL_MIN_W = 340

export interface SurfaceState {
  /** Files is already the main view's mode. */
  filesInMain: boolean
  /** Files is already the panel's tab AND the panel is open. */
  filesInPanel: boolean
}

export interface SurfaceWidths {
  /** The main CONTENT box, not `window.innerWidth` — the sidebar and the panel both eat it, and
   *  a rule keyed on the window sends a link into a 300px main view on a laptop with both open. */
  mainContent: number
  panel: number
}

/** Which surface a deep link should open in. Pure; evaluated in the design's order.
 *
 *  A. Files is already open somewhere → that surface. Not a special case: it is what makes the
 *     link IDEMPOTENT, so clicking two paths in a row cannot ping-pong the reader between two
 *     surfaces.
 *  B/C. Otherwise a link opens in the OTHER surface from the one it was clicked in — the whole
 *     principle, stated above.
 *  D. From elsewhere, the main view wins when it is wide enough to be the better reader.
 *  E. Then one width veto against whatever A–D chose.
 *
 *  The veto can be self-defeating (a narrow panel AND a narrow main view), so it applies at most
 *  once: sending a link back and forth between two too-small surfaces would be an infinite
 *  argument, and the first choice is the better guess. */
export function resolveFileTarget(
  origin: LinkOrigin,
  state: SurfaceState,
  widths: SurfaceWidths,
): FileSurface {
  let chosen: FileSurface
  if (state.filesInMain) chosen = 'main'
  else if (state.filesInPanel) chosen = 'panel'
  else if (origin === 'panel') chosen = 'main'
  else if (origin === 'main') chosen = 'panel'
  else chosen = widths.mainContent >= MAIN_PREFERRED_W ? 'main' : 'panel'

  if (chosen === 'panel' && widths.panel < PANEL_MIN_W) return 'main'
  if (chosen === 'main' && widths.mainContent < MAIN_MIN_W) return 'panel'
  return chosen
}

/** Which of the panel's three measured forms a given width is. §3.
 *
 *  Shared by the panel and by anything that needs to know whether the tree is affordable, so the
 *  thresholds exist once rather than as three literals in a component. */
export type PanelForm = 'wide' | 'medium' | 'narrow'
export function panelForm(width: number): PanelForm {
  if (width >= 560) return 'wide'
  if (width >= PANEL_MIN_W) return 'medium'
  return 'narrow'
}

/** Nav state, per session — mirrors `sessionLayouts`. */
export interface FilesNav {
  root: 'lane' | 'project'
  path?: string
  line?: number
  range?: [number, number]
  expanded: string[]
  /** The `⌄` menu, capped. */
  recent: string[]
  query?: string
}

export const EMPTY_NAV: FilesNav = { root: 'lane', expanded: [], recent: [] }

/** Cap from the design (§9). */
const RECENT_CAP = 10

/** Move `path` to the front of `recent`, deduped and capped. Pure. */
export function pushRecent(recent: readonly string[], path: string): string[] {
  if (!path) return [...recent]
  return [path, ...recent.filter((p) => p !== path)].slice(0, RECENT_CAP)
}

/** Apply a target to the nav state. Pure, so "what does following a link change" is one
 *  readable function rather than four `setState` calls spread across two components. */
export function navigateTo(nav: FilesNav, t: FilesTarget): FilesNav {
  return {
    ...nav,
    root: t.root,
    path: t.path,
    line: t.line,
    range: t.line != null && t.endLine != null ? [t.line, t.endLine] : undefined,
    recent: pushRecent(nav.recent, t.path),
    // Expand every ancestor directory so the tree shows where the file is rather than making
    // the reader hunt for a selection they cannot see.
    expanded: [...new Set([...nav.expanded, ...ancestorsOf(t.path)])],
  }
}

/** Every directory above a repo-relative path, outermost first. Pure. */
export function ancestorsOf(path: string): string[] {
  const parts = path.split('/').filter(Boolean)
  parts.pop() // the file itself
  const out: string[] = []
  let acc = ''
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p
    out.push(acc)
  }
  return out
}
