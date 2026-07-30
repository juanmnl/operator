# Brief — the Agents hub button belongs on the rail, not in the project sidebar

User: *"the agents (robot icon) button should go in the project column, so it lives in a global
position."* Correct, and for the same reason project navigation already moved there.

## Why

`AgentsHubView` is **cross-project** — it takes `projects: Project[]` and iterates all of them
(`AgentsHubView.tsx:28, :46`). It is not scoped to `activeProjectId`. So it does not belong in the
project sidebar, whose whole job after the v0.11.0 work is *this project only*.

**And it is currently unreachable from the gallery.** At `contentMode === 'gallery'` the sidebar strip
animates to width 0 (`DashboardView.tsx`), taking its footer icon row with it — so the one place you
are most likely to want a cross-project view is the one place the button does not exist. `ProjectRail`
persists in every state (expanded, collapsed, gallery), which fixes that as a side effect.

## Change

- **Remove** the agents button from the sidebar footer icon row (`Sidebar.tsx:479`,
  `onClick={onOpenAgents}`). Drop the now-unused `onOpenAgents` prop from `Sidebar` if nothing else
  in it uses it — don't leave a dead prop.
- **Add** it to `ProjectRail`'s foot, using the existing `RailFoot` control (`ProjectRail.tsx:122`)
  along"All projects" and "Open folder". Icon-only at 44px with the title carrying the name and the
  chord, exactly as those two do. Keep the same robot glyph — it is what the user recognises.
- **Order in the foot: Agents, then All projects, then Open folder.** Rationale: the two existing
  ones are *navigation between projects*; Agents is *a view across them*. Put the odd one first so
  the pair stays adjacent, and separate it from them with the existing seam treatment rather than
  inventing a divider.
- Pass `onOpenAgents` through to `ProjectRail` from `DashboardView`.

## Do NOT

- Do not duplicate it — after this it exists in exactly one place. Two routes to one view is what
  we just finished removing from the sidebar header.
- Do not change `AgentsHubView` itself, or how it is reached by `⌘K`.
- Do not restyle the other footer icons to fill the gap; a five-icon row becoming four is fine.

## Traps

- The rail is inside a `DragRegion` at the top; a button there needs `WebkitAppRegion: 'no-drag'`
  or the click is swallowed by window dragging. Check how the existing foot controls handle it and
  match them.
- Icon-only at 44px means the accessible name comes from `aria-label`, not text. Do not ship a
  button whose only label is a glyph.
- No colour-CHANGING border on a radiused element (WKWebView re-rasterizes) — match the existing
  foot controls' hover treatment, which is background-only.
- The rail renders at the gallery too. Confirm the button works there — that is the case this move
  exists to fix, so it is the one to actually verify rather than assume.

## Verify

- `npm test` + `npm run build` green.
- `node dev/drive-project-rail.mjs` — extend it: the agents control exists in the rail foot, has an
  accessible name, and opens the hub. Assert it is reachable **at the gallery**.
- `node dev/drive-sidebar.mjs` — the sidebar footer no longer carries it and nothing else broke.
- `node dev/drive-theme-pass.mjs` — all 6 palettes.

## Write your result to

`dev/briefs/agents-hub-to-rail-RESULT.md` — what moved, whether the gallery case now works, and
anything else in the sidebar footer you think is misplaced for the same reason.
