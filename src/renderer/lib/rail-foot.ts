// THE RAIL FOOT'S TWO TIERS — which of the eight controls stay at rest, and which fold away.
//
// The foot cost four rows, three hairlines and a version line at the bottom of a strip whose
// scarce resource is HEIGHT: every pixel it holds is a pixel the agent list above it does not
// get. The eight are not equals, so the fix is not "collapse all of it" — it is a line drawn
// through them.
//
// THE LINE IS DRAWN ON FREQUENCY, WITH ONE OVERRIDE FOR AMBIENCE.
//
//   RESTING (always drawn) — Agents · Plan usage · All projects · Open folder
//     The first three are the strip's constant verbs, and `Open folder` is how a project enters
//     Operator at all. `Plan usage` is the override: it is the one control here whose value is
//     being SEEN rather than being clicked. A meter you have to unfold to read is a meter you
//     check when you already suspect the answer, which is exactly too late — folding it would
//     cost more than the 24px it returns. It is also the only one of the eight with no keyboard
//     route, because "how much is left" is not a command.
//
//   FOLDED (behind the seam) — .claude · ~/.claude · Preferences · theme
//     Occasional and rare. You open `.claude` when you are editing agent config, Preferences when
//     something is wrong, and the theme toggle a handful of times ever. Rare-but-delightful is
//     precisely the profile that survives folding: delight needs to be FINDABLE, not resident.
//     And every one of the four has a ⌘K route already (`Edit settings for <project>`, `Global
//     Claude files`, `Operator preferences`, `Switch to light/dark mode`), so folding costs a
//     click and never reachability.
//
// THE PAIRS SURVIVE INTACT. The cut lands exactly on an existing hairline — the first two
// hairline-fenced groups (views across projects / navigation between projects) stay, the last two
// (Claude files / app) fold. Nothing is regrouped and nothing is flattened, so the four groups the
// foot already taught still mean what they meant.
//
// DEFAULT IS FOLDED. Defaulting to expanded would mean nobody gets the space back unless they go
// looking for a control they do not know exists, which is the same as not shipping it. The seam
// that reveals them is drawn at rest — the foot is genuinely 67px shorter, not merely emptier.

/** The eight, keyed by the `data-rail-*` attribute each renders — the DOM contract the drivers
 *  assert against, so the tiering cannot drift from what is measured. */
export type FootItemId =
  | 'agents' | 'usage' | 'gallery' | 'open-folder'
  | 'folder-prefs' | 'global-prefs' | 'prefs' | 'theme'

/** Drawn whatever the state. Order is render order: row 1, then row 2. */
export const RESTING_FOOT_ITEMS: readonly FootItemId[] = ['agents', 'usage', 'gallery', 'open-folder']

/** Behind the seam. Order is render order: row 3, then row 4. */
export const FOLDED_FOOT_ITEMS: readonly FootItemId[] = ['folder-prefs', 'global-prefs', 'prefs', 'theme']

/** Alongside `operator.sidebarCollapsed`, which is the RAIL'S WIDTH — a different axis entirely.
 *  Both persist; neither implies the other. */
export const FOOT_EXPANDED_KEY = 'operator.railFootExpanded'

/** Folded unless the user has said otherwise. A read that throws (private mode, quota) is not an
 *  error worth surfacing from a strip ornament — it just means "folded", the default. */
export function readFootExpanded(): boolean {
  try { return localStorage.getItem(FOOT_EXPANDED_KEY) === '1' } catch { return false }
}

export function writeFootExpanded(expanded: boolean): void {
  try { localStorage.setItem(FOOT_EXPANDED_KEY, expanded ? '1' : '0') } catch { /* quota */ }
}

/** What the seam's control says it will do, and what a screen reader announces. Names the COUNT:
 *  a bare "More" does not tell you whether unfolding is worth the click. */
export function footDisclosureLabel(expanded: boolean): string {
  return expanded
    ? `Hide ${FOLDED_FOOT_ITEMS.length} more controls`
    : `Show ${FOLDED_FOOT_ITEMS.length} more controls`
}
