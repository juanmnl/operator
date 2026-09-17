// WHERE YOU CAME FROM, so a full-page view can send you back to it.
//
// The settings pages (`folderPrefs`, `globalPrefs`, `prefs`), the Agents hub and Tuning all wear
// `PageShell` inside `AppShell`, and AppShell's 44px header carries only the sidebar toggle. There
// was no back control and no breadcrumb on any of them, so the Worktrees tab — reached from the
// launcher's worktree overview, which is the screen every launch opens on — was a room with no
// door. The only escape was the rail's "All projects" foot item: an icon at the bottom of a strip
// that may be collapsed to 60px, and it lands on the PROJECTS tab, not the overview you left.
//
// THE RULE, decided rather than derived: the control returns to the EXACT origin and is labelled
// with that origin's own name. Not a fixed "All projects", not a close ✕. And when there is no
// origin — a reload, or a page restored straight into by the launch plan — there is NO control.
// A back button that guesses is worse than none: it teaches you it cannot be trusted.
//
// This module is that decision, kept pure so it is testable without a renderer: the view you are
// on → a place you can be sent back to, and a place → the words on the button.
//
// IT REUSES `ContinueTarget` (lib/workspace) rather than inventing a second "a view you can return
// to". Two shapes for one idea is how the launcher's Continue offer and this control would start
// disagreeing about what a view is. The four optional fields below are what a back control needs
// and a launch offer never did: which gallery TAB; which of the two pages that both report
// `mode: 'prefs'` is meant; and WHICH LANE, when the place you left was a focused one.

import type { ContinueTarget } from './workspace'
import type { GalleryTab } from '../components/dashboard/ProjectGallery'
import type { FolderPrefsTab } from '../components/preferences/FolderPreferencesView'

/** The per-project settings page's own identity: `activeFolderPrefs` in DashboardView. */
export interface FolderPrefsOrigin {
  projectPath: string
  projectName: string
  tab?: FolderPrefsTab
}

/** A FOCUSED LANE, as a place.
 *
 *  The terminal id only. It is a per-RUN counter (`t0`, `t1`, … — see terminal_spawn) that repeats
 *  every launch, which is the same reason `SavedSession.terminalId` is documented as stale after a
 *  restart. So this must never be persisted, and the chain that holds it is in-memory and capped.
 *  Within one run it is exactly right: it is what `contentMode` itself tests to decide whether a
 *  lane is on screen, and it tells two lanes of one project apart.
 *
 *  No session id, no name. Both are resolved AT THE MOMENT the control renders or is pressed —
 *  a name the user has since changed, or a session id that has since been replaced, would make
 *  the control describe a lane that no longer reads that way. */
export interface LaneOrigin {
  terminalId: string
}

/** A live lane, named by the app's one label ladder (`lib/session-label`). The caller builds these
 *  from what is ACTUALLY open; `originLabel` treats absence from this list as "the lane is gone". */
export interface LaneRef {
  terminalId: string
  name: string
}

/** A view you can be sent back to. `ContinueTarget` plus the four things it never had to say. */
export interface NavOrigin extends ContinueTarget {
  /** Which tab the gallery was on. Restoring the gallery without it drops you on `projects`,
   *  which is not the screen you left. */
  galleryTab?: GalleryTab
  /** Present = this is the per-PROJECT settings page. `mode` is `'prefs'` for both it and
   *  Operator preferences (the workspace snapshot has no separate name for them), so presence
   *  is what tells the two apart. */
  folderPrefs?: FolderPrefsOrigin
  /** Which tab Global settings was on. */
  globalPrefsTab?: FolderPrefsTab
  /** Present = a focused LANE, not the project's home. `mode` is `'project'` for both (the lane's
   *  project is still the scope to restore), so — as with `folderPrefs` — presence is what tells
   *  them apart. */
  lane?: LaneOrigin
}

/** The content modes that wear `PageShell` — the pages this control appears on. */
export const PAGE_MODES = ['folderPrefs', 'globalPrefs', 'prefs', 'agents', 'tuning'] as const
export type PageMode = (typeof PAGE_MODES)[number]

export function isPageMode(mode: string): mode is PageMode {
  return (PAGE_MODES as readonly string[]).includes(mode)
}

/** Everything `describeOrigin` needs to name the view on screen. Mirrors DashboardView's state. */
export interface ViewState {
  /** DashboardView's `contentMode`. */
  contentMode: string
  projectId: string | null
  projectTab: ContinueTarget['projectTab']
  galleryTab: GalleryTab
  folderPrefs: FolderPrefsOrigin | null
  globalPrefsTab?: FolderPrefsTab
  /** The pty that has focus. Set exactly when `contentMode` is `'localTerminal'`. */
  terminalId?: string | null
}

/** The view on screen, as somewhere you could be returned to — or `null` when it is not a place
 *  this control can both NAME and RESTORE.
 *
 *  A FOCUSED LANE is a place, and it is the commonest origin there is: you are in a lane, you hit
 *  Preferences or Global settings from the rail's foot. It carries the lane's terminal id and the
 *  project scope around it. What it does NOT do is degrade — see `originLabel`: a lane that has
 *  ended, been closed or had its worktree reaped is not replaced by its project, because pressing
 *  a control labelled with a lane's name has to land on that lane or not be there at all. */
export function describeOrigin(v: ViewState): NavOrigin | null {
  const base = { projectId: v.projectId, projectTab: v.projectTab }
  switch (v.contentMode) {
    case 'gallery':
      // The gallery is outside every project, so its origin carries no project scope — restoring
      // one would re-enter a project the user had left.
      return { ...base, projectId: null, mode: 'gallery', galleryTab: v.galleryTab }
    case 'project':
      return v.projectId ? { ...base, mode: 'project' } : null
    case 'prefs':
      return { ...base, mode: 'prefs' }
    case 'globalPrefs':
      return { ...base, mode: 'globalPrefs', globalPrefsTab: v.globalPrefsTab }
    case 'folderPrefs':
      return v.folderPrefs ? { ...base, mode: 'prefs', folderPrefs: v.folderPrefs } : null
    case 'localTerminal':
      // `mode: 'project'` — the scope to restore around the lane is still its project, and
      // `contentMode` ranks a live lane above the project home, so the lane wins on arrival.
      return v.terminalId ? { ...base, mode: 'project', lane: { terminalId: v.terminalId } } : null
    case 'agents':
      return { ...base, mode: 'agents' }
    case 'tuning':
      return { ...base, mode: 'tuning' }
    default:
      return null
  }
}

/** One string per PLACE, so "am I already here?" and "is this page already in the chain?" are the
 *  same comparison. Not a hash of the whole origin: two visits to the gallery's overview tab from
 *  different projects are the same place. */
export function originKey(o: NavOrigin): string {
  switch (o.mode) {
    case 'gallery': return `gallery:${o.galleryTab ?? 'projects'}`
    // Two lanes of one project are two places, so the lane — not the project — is the key.
    case 'project': return o.lane ? `lane:${o.lane.terminalId}` : `project:${o.projectId ?? ''}`
    case 'prefs': return o.folderPrefs ? `folderPrefs:${o.folderPrefs.projectPath}` : 'prefs'
    default: return o.mode
  }
}

/** The words on the button — the origin's OWN name, and `null` when it no longer has one.
 *
 *  A project that has since been forgotten returns null, and the caller renders nothing: a label
 *  is a promise about where the press lands, and there is no longer anywhere to land. */
export function originLabel(
  o: NavOrigin,
  projects: ReadonlyArray<{ id: string; name: string }>,
  lanes: readonly LaneRef[] = [],
): string | null {
  switch (o.mode) {
    case 'gallery':
      switch (o.galleryTab) {
        case 'overview': return 'Worktree overview'
        case 'activity': return 'Activity'
        default: return 'All projects'
      }
    case 'project': {
      if (o.lane) {
        // THE EXISTENCE GUARD, and the whole of it. A lane can end, be closed, or have its
        // worktree reaped while the user sits in settings. Absent from the live list = no label,
        // so no control — never the lane's PROJECT instead, which would be a control labelled
        // with one destination that lands on another.
        const name = lanes.find((l) => l.terminalId === o.lane!.terminalId)?.name.trim()
        return name || null
      }
      const name = projects.find((p) => p.id === o.projectId)?.name.trim()
      return name || null
    }
    case 'prefs': {
      if (!o.folderPrefs) return 'Preferences'
      // Mirrors `folderPrefsTitle` — the page names itself this way, and a back control that
      // renamed its destination would be describing a screen the user cannot find. Bound with
      // non-breaking spaces for the same reason it is there: the name must not end up alone
      // after the separator. `folder-prefs-title.test.ts` holds the two together.
      const name = o.folderPrefs.projectName.trim()
      return name ? `Project settings · ${name}` : 'Project settings'
    }
    case 'globalPrefs': return 'Global settings'
    case 'agents': return 'Agents'
    case 'tuning': return 'Tuning'
    default: return null
  }
}

/** How deep the chain may get. Settings pages reach each other through the rail's foot, so a
 *  chain is real; an unbounded one is a memory of navigation nobody asked to keep. */
export const ORIGIN_STACK_MAX = 8

/** Entering the page `targetKey` from `origin`. Pure — the caller holds the stack.
 *
 *  Three cases, and the last two are what stop a back control pointing at the page you just left:
 *  - no origin → the chain is dropped, and the new page renders no control (the rule above);
 *  - you are ALREADY on that page (pressing "Preferences" while in Preferences) → nothing moves;
 *  - the page is already in the chain (gallery → prefs → globals → prefs) → the chain UNWINDS to
 *    it, instead of growing a loop where two pages each claim to be the other's origin. */
export function pushOrigin(stack: readonly NavOrigin[], origin: NavOrigin | null, targetKey: string): NavOrigin[] {
  if (!origin) return []
  if (originKey(origin) === targetKey) return [...stack]
  const at = stack.findIndex((o) => originKey(o) === targetKey)
  if (at >= 0) return stack.slice(0, at)
  return [...stack, origin].slice(-ORIGIN_STACK_MAX)
}
