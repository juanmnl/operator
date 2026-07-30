import { ACCENT_SWATCHES } from './lane-accents'

// A stable IDENTITY colour per project, for the always-present project rail.
//
// The rail's whole premise is spatial memory — "mantel is the amber one". That only works if
// the colour never moves, so it cannot come from status (a project would change colour as it
// worked) and it cannot come from list position (projects reorder by liveness on every tick).
// It is hashed from the project id, which is the one thing about a project that never changes.
//
// DERIVED, NOT PERSISTED: no new field on Project, no migration, and nothing to keep in sync.
// The cost is that two projects can share a colour (12 swatches, and the real store has 19) —
// acceptable, because the orb is never the only identifier: the rail rings the current one,
// every orb has a hover card with the name, and the sidebar beside it spells the names out.
//
// The palette is the lane picker's, so a project orb and a lane orb read as one system. Lane
// accents are DATA and these are derived, but they're drawn side by side and a second palette
// would look like a second meaning.

/** The picker's swatches minus slate. In the lane picker slate is the deliberate "no colour"
 *  choice; as an IDENTITY it reads as "this project doesn't have one", which is the opposite
 *  of the job. Eleven chromatic swatches. */
const NO_COLOUR = '#94a3b8'
export const PROJECT_ACCENTS: string[] = ACCENT_SWATCHES.filter((c) => c !== NO_COLOUR)

/** FNV-1a over the id. Any stable string hash would do; what matters is that it depends on
 *  the ID ALONE — hashing an array index would repaint the whole rail the first time two
 *  projects swapped places, which is precisely the failure this exists to prevent. */
export function projectAccent(id: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return PROJECT_ACCENTS[(h >>> 0) % PROJECT_ACCENTS.length]
}

/** The rail tile's acronym — the second identity channel, because colour alone cannot keep
 *  `fastrack` / `Fastrack-landing` / `FastTrack` apart (11 swatches, and near-identical names
 *  are exactly the case that motivated this).
 *
 *  Splits on separators AND camelCase — the camelCase boundary is what makes `FastTrack` read
 *  `FT` rather than `FA` and collide with plain `fastrack`. Two or more parts take the first
 *  letter of each of the first two; a single part takes its first two letters.
 *
 *  Collisions are tolerated: the tile also carries a colour, and a uniquing scheme would make
 *  a project's acronym depend on its NEIGHBOURS — the same instability `projectAccent` avoids
 *  by hashing the id instead of the index. */
export function projectInitials(name: string): string {
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[-_.\s]+/)
    .filter(Boolean)
  if (parts.length === 0) return '?'
  const s = parts.length >= 2 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2)
  return s.toUpperCase()
}
