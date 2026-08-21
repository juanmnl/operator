// THE ONE LEFT EDGE, expanded — the single number that five call sites have to agree on.
//
// It lives in its own module for the reason `foot-cell.ts` does: `SessionItem` needs it and
// `ProjectRail` renders `SessionItem`, so importing it from that component would be a cycle. It
// was a local const there and a bare `8` literal in the rest, held together by a comment in each
// that named the other — which is the arrangement that lets one of them drift while the comments go
// on claiming it can't. One of them already had: the open group's path.

/** EXPANDED, everything in the strip starts here: a group header's text, the open group's path, a
 *  member row's orb, the Home mark and the `+` of `Start an agent`. ONE left edge for the whole
 *  strip.
 *
 *  IT IS NOT THE COLLAPSED AXIS, and it is not chosen either. THE CHOSEN NUMBER IS THE ⌘B ORB
 *  SLIDE — 10px, accepted on 2026-08-04 when the constant-x invariant was retired (user's call: "agent
 *  orb should be more to the left, balanced"; holding the orb column at 2 × the axis had cost ~30px
 *  of the name column) and re-affirmed on 2026-08-21. This is that number solved for:
 *
 *      slide = collapsed orb centre (AXIS) − expanded orb centre (ROW_INSET_L + ORB/2)
 *       →  ROW_INSET_L = AXIS − ORB/2 − SLIDE = 35 − 12 − 10 = 13
 *
 *  WRITTEN OUT RATHER THAN COMPUTED, deliberately: `AXIS` and `ORB` live in `ProjectRail`, which
 *  imports this module, so reaching for them here is the cycle this module was extracted to avoid.
 *  `dev/drive-rail-invariant.mjs` assertion X holds the arithmetic instead — and it now ASSERTS the
 *  slide rather than printing it, which is not the retired invariant coming back: that one demanded
 *  Δx = 0, this one demands Δx = the number someone chose. It exists because the comment-only
 *  version has already failed twice. This was 8 (a 10px slide against the 60px strip's axis of 30);
 *  `RAIL_W` went to 70 for the Electron shell's larger traffic lights, took the axis to 35, and took
 *  the slide to 15 with it. Nobody chose 15. If `RAIL_W` moves again, assertion X fails and this
 *  line is the one to re-solve. */
export const ROW_INSET_L = 13
