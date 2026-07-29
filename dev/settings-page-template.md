# Canonical settings-page template

**Status:** design agreed 2026-07-28, not yet implemented. Code applies it after.
**Problem:** every full-page view hand-rolls its own header, section headers and measure, so the same role is styled three different ways. The fix is not "pick nicer values" — it's to make the shell a *component* and the type a *set of exported tokens*, so the next page can't invent a sixth variant.

Scope: `PrefsView`, `FolderPreferencesView` (per-project **and** global `~/.claude`), `AgentsHubView`, `AgentLibraryView`. (`UsageView` was deleted by another lane on 2026-07-27 and is not part of this.)

---

## 1. The diagnosis, precisely

| # | Symptom | What's actually wrong |
|---|---|---|
| 1 | `PrefsView` `<h3>` alternates mono-uppercase-muted (Updates, Theme) vs body 12/600 `--fg` (Dock icon, Sounds, Terminal) | The three "plain" ones aren't a second *section-header* style — they're the **field-label** style (12/600 `--fg`, exactly what `GeneralSection`/`InstructionsSection` use for individual field labels). So a section header and the labels inside it currently render identically. That's the bug, not merely the inconsistency. |
| 2 | `<h2>`: display 17/700 (Prefs, AgentsHub) vs body 14/600 (FolderPrefs) | Same role, two values. 17/700 is the majority and is the display face doing the job it exists for. FolderPrefs is the outlier. |
| 3 | Flat scroll vs tabbed | **Legitimately different — but the rule was never written down**, so it reads as arbitrary. See §4. |
| 4 | 720 vs 1100 (and `AgentLibraryView`'s editor pane at **640** — an undocumented third measure) | Measure should follow **content type**, not page identity. See §5. |

Two things to fix while in there, since standardizing around them would cement them:

* **Stacked `opacity` on `--fg-muted`** — `PrefsView` 213/226/295/315/329/363, `FolderPreferencesView` 71, `AgentsHubView` 68. The token already carries the recede; stacking measures 1.8–2.9:1 and is invisible on the three light palettes. See `dev/project-first-navigation.md` §5 and the four-theme pass.
* **`FolderPreferencesView`'s tab sections have no section headers at all** — each opens straight into a `<p>`. That's correct (§4), but it means the section-header token only applies to *flat* pages and to sub-sections **inside** a tab.

---

## 2. The page shell — one component, every full-page view

New `src/renderer/components/settings/PageShell.tsx`. Not settings-specific: `AgentsHubView` uses it too. The only structural variable is whether a tab bar sits between header and content.

```
<PageShell
  title="Operator preferences"
  subtitle="App-level behavior. Per-project Claude Code settings live in the project's gear menu."
  measure="form"                       // 'form' | 'grid'
  tabs={TABS} active={tab} onSelectTab={setTab}   // omit → flat page
>
  …sections or the active tab's content…
</PageShell>
```

```
┌─ root: flex column, flex:1, overflow:hidden, font-body ────────────┐
│ ┌─ header: padding 16px 24px 0, flexShrink:0, MEASURE ───────────┐ │
│ │  h2   title      — display 17/700, -0.01em, --fg               │ │
│ │  p    subtitle   — 11, --fg-muted, margin 4px 0 0, NO opacity  │ │
│ └────────────────────────────────────────────────────────────────┘ │
│ ┌─ tab bar (optional): padding 16px 24px 0, MEASURE ─────────────┐ │
│ │  borderBottom 1px --border; button 12/500;                     │ │
│ │  active --fg + borderBottom 2px --accent, else 2px transparent │ │
│ └────────────────────────────────────────────────────────────────┘ │
│ ┌─ scroller: flex:1, minHeight:0, overflow:auto — FULL WIDTH ────┐ │
│ │ ┌─ measure box: padding 20px 24px 40px, MEASURE ─────────────┐ │ │
│ │ │  content                                                   │ │ │
│ └─┴────────────────────────────────────────────────────────────┴─┘ │
└────────────────────────────────────────────────────────────────────┘
```

**The scroller/measure split is load-bearing and already correct in all three pages — keep it.** Putting `maxWidth` + `margin:auto` on the scrolling element parks the native scrollbar at that shrunk box's edge, floating mid-window instead of flush to it. Full-width scroller, measure on an inner div.

> **Guardrail — this is a PAGE header, not a toolbar header.** `ProjectView` and `ProjectGallery` use 13–14px/600 titles inside a compact 40–44px drag-region bar. That is a *different component* and must not be "standardized" to 17/700. The tell: a page header owns a 16px-padded block with a subtitle; a toolbar header is a fixed-height strip with controls beside the title.

---

## 3. Type tokens

Exported from the same module so nothing re-declares them inline.

| Token | Value | Used for |
|---|---|---|
| `pageTitle` | `--font-disp`, **17px / 700**, `-0.01em`, `--fg` | the `<h2>`, every full-page view |
| `pageSubtitle` | 11px, `--fg-muted`, `margin: 4px 0 0` | one line under the title |
| `sectionHeader` | `--font-mono`, **11px / 500, uppercase, 0.14em**, **`--fg`** | `<h3>` on flat pages, and sub-sections inside a tab |
| `sectionDesc` | 11px, `--fg-muted`, `lineHeight: 1.5`, `margin: 0 0 12px` | the explanatory line under a section header |
| `fieldLabel` | 12px / 500, `--fg` | an individual control's label — **unchanged**, already correct |

**Resolving (1): keep the mono-uppercase form, but in `--fg`, not `--fg-muted`.**
- Uppercase/tracked/mono is already the app's section-label idiom everywhere else (sidebar `AGENTS`, `RosterPanel`'s `Live · N`/`Ready · N`, `AgentsHubView`'s `SubHead`, `RecentLists`). Choosing the plain-body form would make settings the one surface that disagrees with the whole app.
- It must step to **`--fg`** because the description beneath it is `--fg-muted`: once the illegal `opacity` comes off, a muted header and a muted description are the *same ink*, and the header stops being a header. `--fg` also clears the 4.5:1 body bar on every palette, which `--fg-muted` at 11px does not.
- It is one step up from the 9.5px `SubHead` used over card grids, deliberately: a settings section owns a whole block, an eyebrow merely labels a list.

Section spacing stays `marginBottom: 28` (already consistent everywhere).

---

## 4. Flat vs tabbed — the rule

> **Flat** by default. Go **tabbed** only when *either*: (a) sections are each long enough to fill a screen on their own, or (b) sections are scoped to **different underlying files/objects**, so stacking them would imply an edit applies more broadly than it does.

Applying it:

* **`PrefsView` → stays flat.** Five sections of a few controls each; tabbing would cost five clicks to see five short things.
* **`FolderPreferencesView` → stays tabbed.** Both conditions hold: each tab is a substantial editor, and each is scoped to a *different file* (`CLAUDE.md` vs `settings.json` permissions vs general vs hooks vs plugins), several with their own `SettingsFileTabBar` for which file within the scope. Flattening would stack five file-pickers into one page and blur which file an edit lands in.
* **`AgentsHubView` → stays tabbed** (Fleet / Subagent library) — condition (b): two different objects.

**Corollary:** in a tabbed page, **the tab name IS the section header** — do not also render an `<h3>` repeating it. `FolderPreferencesView`'s sections already do this correctly; the template makes it a rule rather than an accident. `sectionHeader` inside a tab is only for genuine *sub*-sections.

---

## 5. Measure — follows content, not page

| Token | Value | For |
|---|---|---|
| `MEASURE_FORM` | **720** | prose, forms, settings, editors — anything read line by line |
| `MEASURE_GRID` | **1100** | card grids, which need columns more than they need a comfortable line length |

* `PrefsView`, `FolderPreferencesView` → `form` (720). Already correct.
* `AgentsHubView` → `grid` (1100). **Justified, keep** — its content is `repeat(auto-fill, minmax(232px, 1fr))`, the same reason `ProjectGallery` uses 1100. A 720 cap would strand it at two columns on a wide window.
* `AgentLibraryView` → the two-column list+detail shell keeps `grid` (1100); its **editor pane's `maxWidth: 640` (line 300) converges to 720**. 640 is a third measure nothing else uses, and it's a form — the exact case `MEASURE_FORM` exists for.

One caveat for Code: 720 vs 1100 changes where the *header* sits too, since header and content share the measure. That's intended — a header that doesn't share its content's left edge is the bug fixed on `ProjectGallery` (Δ was ~100px).

---

## 6. Change list

**New** `src/renderer/components/settings/PageShell.tsx` — `PageShell`, `SettingsSection`, and the tokens in §3 + measures in §5.

**`PrefsView.tsx`** — adopt `PageShell` (flat, `form`). Convert all five `<h3>` to `sectionHeader` (the three at ~312/326/360 currently render as field labels). Drop `opacity` at 213/226/295/315/329/363.

**`FolderPreferencesView.tsx`** — adopt `PageShell` (tabbed, `form`). `<h2>` 14/600 → `pageTitle`; project path stays the subtitle, drop its `opacity: 0.6` (line 71). Tab bar markup moves into the shell.

**`AgentsHubView.tsx`** — adopt `PageShell` (tabbed, `grid`). Title already correct; drop `opacity: 0.7` (line 68).

**`AgentLibraryView.tsx`** — standalone header adopts `PageShell` (`grid`); editor pane 640 → `MEASURE_FORM`.

**Do not touch** `ProjectView` / `ProjectGallery` headers — toolbar headers, not page headers (§2 guardrail).

---

## 7. Verification

Extend `dev/drive-theme-pass.mjs` with a settings sweep across all six palettes: for each of the four pages, probe `pageTitle`, `sectionHeader`, `sectionDesc` and `fieldLabel`. Expect **0 below floor** (4.5:1 body / 3:1 meta) — `sectionHeader` in `--fg-muted` would fail that bar on the light palettes, which is the measurement behind the `--fg` call in §3.

Assert the template mechanically, not just visually:
- every page's `<h2>` computes to the same `font-family` / `font-size` / `font-weight`;
- every `<h3>` on a flat page computes identically to every other;
- header and content measure boxes share a left edge (`Δ0px`), per page;
- no element carries a numeric `opacity` on top of `color: var(--fg-muted)`.

Tag the shell's parts (`data-page-title`, `data-page-subtitle`, `data-section-header`) so probes don't depend on nesting — the nth-child selectors in the last pass silently re-pointed when rows were regrouped.

---

## 8. Verification result — 2026-07-28

`dev/drive-theme-pass.mjs` (six palettes, contrast) and `dev/drive-settings-template.mjs` (structure) both run against the four pages. Mock fixtures had to be populated first: `folderPrefsLoad`/`agentsList` returned empty arrays, so every FolderPreferences tab and the whole agent editor rendered empty states — the sweep would have measured blank pages and reported a false pass.

**PASS — contrast: 0 below floor** on all six palettes for `pageTitle` / `pageSubtitle` / `sectionHeader` / `sectionDesc` / `fieldLabel` / active tab, on all four pages.

**PASS — structure:** page title byte-identical across all four pages; 5 section headers and 6 descriptions resolve to exactly **1 distinct computed style each**; every tabbed page renders **0** `<h3>`s (the §4 corollary holds); `grid` vs `form` measures correct.

**Fixed during verification** (all the muted-opacity rule, all found by the sweep, none visible to the eye):
- `AgentLibraryView` field hint — 2.16–3.46:1, under even the 3:1 meta floor on five of six palettes.
- `AgentLibraryView`'s `Field` label was a local 11/600 restatement instead of the `fieldLabel` token — the token existed but **nothing imported it**, so the exact drift the template exists to end still lived one layer below the page chrome.
- `InstructionsSection` scope hints, `AgentsHubView`'s roll-up count and `SubHead` — stacked opacity on `--fg-muted`.

**OPEN — `PrefsView` header/content Δ-3px.** Not cosmetic and not a harness artifact: the scroller carries a **6px space-taking scrollbar**, so the content measure box centres inside `clientWidth` (1190) while the header, outside the scroller, centres inside `offsetWidth` (1196). It only bites when scrollbars take space (macOS "Show scroll bars: Always", or any mouse connected) **and** the page is tall enough to scroll — PrefsView is the only one today, which is why it reads as page-specific rather than as the shell defect it is.

> Recommended fix (Code's call — it changes scroll behaviour, so not applied here): move the header **inside** the scroller and pin it with `position: sticky; top: 0` + a `--bg-terminal` background. Header and content then share one containing block and one left edge at any scrollbar width, and the header still stays put. `scrollbar-gutter: stable` does *not* fix it — it reserves the gutter inside the scroller only, so the header still centres 3px wider.
