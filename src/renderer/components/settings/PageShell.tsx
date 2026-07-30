import type { CSSProperties, ReactNode } from 'react'

// The one shell every FULL-PAGE view wears — settings and not-settings alike (the Agents hub
// uses it too). Before this, four pages each re-declared their own header: two different <h2>
// values for the same role, and <h3>s that rendered in the FIELD-LABEL style, so a section
// header and the labels inside it were the same ink. See dev/settings-page-template.md.
//
// GUARDRAIL: this is a PAGE header, not a toolbar header. ProjectView / ProjectGallery use a
// 13–14px title inside a compact drag-region strip; that's a different component and must not
// be standardized to this. The tell: a page header owns a 16px-padded block with a subtitle.

/** Measure follows CONTENT, not page identity (§5). */
export const MEASURE_FORM = 720   // prose, forms, settings, editors — read line by line
export const MEASURE_GRID = 1100  // card grids, which need columns more than a comfortable line

// --- type tokens ---------------------------------------------------------------------
// Exported so nothing re-declares them inline and drifts again.

export const pageTitle: CSSProperties = {
  fontFamily: 'var(--font-disp)', fontSize: 17, fontWeight: 700,
  letterSpacing: '-0.01em', color: 'var(--fg)', margin: 0,
}

/** One line under the title. No opacity — `--fg-muted` already carries the recede. */
export const pageSubtitle: CSSProperties = {
  fontSize: 11, color: 'var(--fg-muted)', margin: '4px 0 0', lineHeight: 1.6,
}

/** `<h3>` on a flat page, and genuine SUB-sections inside a tab. Mono-uppercase is the
 *  app's section-label idiom everywhere (sidebar AGENTS, roster Live · N, hub SubHead) —
 *  but in `--fg`, not `--fg-muted`: the description under it is muted, so a muted header
 *  would be the same ink as its own body text and stop reading as a header. */
export const sectionHeader: CSSProperties = {
  fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 500,
  textTransform: 'uppercase', letterSpacing: '0.14em',
  color: 'var(--fg)', margin: '0 0 2px',
}

/** The explanatory line under a section header. */
export const sectionDesc: CSSProperties = {
  fontSize: 11, color: 'var(--fg-muted)', lineHeight: 1.5, margin: '0 0 12px',
}

/** An individual control's label. Unchanged — it was already right. */
export const fieldLabel: CSSProperties = {
  fontSize: 12, fontWeight: 500, color: 'var(--fg)',
}

/** Standard gap between sections on a flat page. */
export const SECTION_GAP = 28

export interface PageTab {
  id: string
  label: string
}

export function PageShell({
  title, subtitle, measure = 'form', tabs, active, onSelectTab, scroll = 'page', children,
}: {
  title: string
  subtitle?: string
  measure?: 'form' | 'grid'
  /** Omit for a flat page. In a tabbed page the TAB NAME IS the section header — don't
   *  also render an <h3> repeating it (§4 corollary). */
  tabs?: PageTab[]
  /** Who owns the scrolling.
   *
   *  `page` (default) — the shell scrolls its children inside one measure box. Right for
   *  documents: settings, forms, card grids.
   *
   *  `child` — the shell owns ONLY the header and tab bar; the body is handed the remaining
   *  height, full-bleed, and scrolls itself. Required by a split pane like the agent library,
   *  whose two columns each scroll independently: dropped into the page scroller its root's
   *  `flex: 1` has no flex parent, so the row gets `height: auto`, neither column's
   *  `overflow: auto` ever engages, and the empty state's `height: 100%` collapses. */
  scroll?: 'page' | 'child'
  active?: string
  onSelectTab?: (id: string) => void
  children: ReactNode
}) {
  const max = measure === 'grid' ? MEASURE_GRID : MEASURE_FORM
  // Header, tab bar and content all share one measure, so they share one left edge. (A
  // header that doesn't is the ~100px misalignment that had to be fixed on ProjectGallery.)
  // In `child` mode the body is full-bleed by definition, so the header drops the cap too —
  // otherwise a centred title floats inboard of the pane it belongs to.
  const measureBox: CSSProperties = scroll === 'child'
    ? { width: '100%', boxSizing: 'border-box' }
    : { width: '100%', maxWidth: max, margin: '0 auto', boxSizing: 'border-box' }

  const header = (
    <>
      <div style={{ ...measureBox, padding: '16px 24px 0' }}>
        <h2 data-page-title style={pageTitle}>{title}</h2>
        {subtitle && <p data-page-subtitle style={pageSubtitle}>{subtitle}</p>}
      </div>
      {tabs && tabs.length > 0 && (
        <div style={{ ...measureBox, padding: '16px 24px 0' }}>
          <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--border)' }}>
            {tabs.map((t) => {
              const on = t.id === active
              return (
                <button
                  key={t.id}
                  data-page-tab={t.id}
                  onClick={() => onSelectTab?.(t.id)}
                  style={{
                    padding: '6px 12px', fontFamily: 'inherit', fontSize: 12, fontWeight: 500,
                    background: 'transparent', border: 'none', outline: 'none', cursor: 'pointer',
                    color: on ? 'var(--fg)' : 'var(--fg-muted)',
                    // Constant 2px so switching tabs never reflows the row; colour only ever
                    // lands on a straight rule, never a radiused edge (the WKWebView rule).
                    borderBottom: `2px solid ${on ? 'var(--accent)' : 'transparent'}`,
                    marginBottom: -1,
                  }}
                >
                  {t.label}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </>
  )

  if (scroll === 'child') {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', fontFamily: 'var(--font-body)' }}>
        <div style={{ flexShrink: 0 }}>{header}</div>
        {/* The body gets the remaining height and manages its own scrolling. No measure box:
            a split pane's columns ARE the layout. */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {children}
        </div>
      </div>
    )
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', fontFamily: 'var(--font-body)' }}>
      {/* Scroller FULL WIDTH, measure on the inner boxes: maxWidth + margin:auto on the
          scrolling element itself parks the native scrollbar at that shrunk box's edge,
          floating mid-window instead of flush to it.

          The header lives INSIDE this scroller and is pinned with position:sticky (§8). It
          used to sit outside, as a sibling — which meant it centred inside the scroller's
          offsetWidth while the content centred inside its clientWidth, so a space-taking
          scrollbar (macOS "Always", or any mouse attached) pushed the two measures 3px out
          of line on any page long enough to scroll. Same containing block = same left edge
          at every scrollbar width. `scrollbar-gutter: stable` does NOT fix THAT on its own: the
          gutter is reserved inside the scroller only, so an outside header still centres 3px
          wider.

          Same containing block is only HALF the fix, though. It stops the header and the
          content disagreeing with EACH OTHER; it does nothing about them both moving relative
          to the WINDOW. Measured: the whole page slid 400 → 397 the moment it got long enough
          to scroll, because a centred box re-centres inside a content box 6px narrower.

          `overflow-y: scroll` (not `auto`) is what fixes that half: it keeps the scrollbar's
          6px reserved whether or not the content overflows, so the measure box centres in the
          same width in both states. The reserved strip costs nothing visually — the track is
          transparent and a non-overflowing scroller draws no thumb, so a short page looks
          exactly as it did. `scrollbar-gutter: stable` is the modern spelling of this and
          WebKit PARSES it (CSS.supports says yes) but does not implement it — measured: a
          probe with the gutter set reserved 0px. Do not swap this back. */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'scroll', overflowX: 'auto' }}>
        {/* One sticky block for ALL the page chrome — header and tab bar pin together, so
            the tab bar can't slide under the title. Opaque background, or the content
            scrolls through it. */}
        <div style={{ position: 'sticky', top: 0, zIndex: 2, background: 'var(--bg-terminal)' }}>
          {header}
        </div>

        <div style={{ ...measureBox, padding: '20px 24px 40px' }}>
          {children}
        </div>
      </div>
    </div>
  )
}

/** A section on a FLAT page: mono-uppercase header, optional muted description, content. */
export function SettingsSection({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: SECTION_GAP }}>
      <h3 data-section-header style={sectionHeader}>{title}</h3>
      {desc && <p data-section-desc style={sectionDesc}>{desc}</p>}
      {children}
    </section>
  )
}
