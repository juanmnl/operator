// THE ONE LEFT EDGE, expanded — the single number that four call sites have to agree on.
//
// It lives in its own module for the reason `foot-cell.ts` does: `SessionItem` needs it and
// `ProjectRail` renders `SessionItem`, so importing it from that component would be a cycle. It
// was a local const there and a bare `8` literal in the other two, held together by a comment in
// each that named the other — which is the arrangement that lets one of them drift while three
// comments go on claiming it can't.

/** EXPANDED, everything in the strip starts here: a group header's text, a member row's orb, the
 *  Home mark and the `+` of `Start an agent`. ONE left edge for the whole strip.
 *
 *  IT IS NOT THE COLLAPSED AXIS. The constant-x invariant — an orb at the same absolute x in both
 *  states — was retired on 2026-08-04 (user's call: "agent orb should be more to the left,
 *  balanced"), and holding the orb column at 2 × the axis is what had cost ~30px of the name
 *  column. The accepted trade was that the orb SLIDES when the strip expands, and the size of that
 *  slide is what this number sets:
 *
 *      slide = collapsed orb centre (AXIS) − expanded orb centre (ROW_INSET_L + ORB/2)
 *
 *  It was 8, for a 10px slide against the 60px strip's axis of 30. `RAIL_W` then went to 70 for the
 *  Electron shell's larger traffic lights, taking the axis to 35 and the slide with it to 15 — a
 *  number nobody chose. 12 puts it back to 11, which is the accepted trade again, and 12 is not an
 *  arbitrary pick: it is exactly what `MEMBER_INSET_L` was while the strip was 60 wide.
 *
 *  `dev/drive-rail-invariant.mjs` asserts the agreement (assertion L) and reports the slide
 *  (assertion X, informational since the invariant was retired). */
export const ROW_INSET_L = 12
