// THE LETTER IN THE ORB — one character per lane, two only for the lanes that actually collide.
//
// An initial depends on its PEERS, which is why this is a per-roster resolver rather than a
// per-name function: `Research` is `RS` only because `Review` is in the same roster, and two lanes
// with the same name can only be told apart by their position in it. Resolve the list at once, or
// the index case is unassignable.
//
// This is deliberately not `projectAccent`'s rule, which refuses to depend on neighbours. The
// scopes differ: that protects an identity that must stay learnable across a 20-project store
// whose ORDER changes on every tick. Here the scope is one roster the user authored, the growth is
// triggered by them adding a colliding lane, and it is bounded to the colliding pair — `Design` is
// `D` forever, whatever else arrives. A letter that lengthens the moment two lanes become
// ambiguous is REPORTING the ambiguity, not hiding it.
//
// THE INVARIANT, and it is the whole point: no two lanes in one roster ever show the same initial.
// The rail carried an orb letter before D1 and its own comment admitted it could not hold this —
// "Research and Review both reduce to R … duplicates are unsolved at this width". A collision the
// user can see destroys trust in the channel, so the last step below is a hard dedupe rather than
// a hope.

/** Astral-safe split: `Array.from` keeps a surrogate pair (or an emoji) as ONE element, where
 *  `name[0]` would return half of it. */
const chars = (s: string): string[] => Array.from(s)

/** The one-character base: the first LETTER OR DIGIT, so `_scratch` is `S` and not `_`. Falls back
 *  to the first character at all, then to `?`, so a whitespace-only or empty name still draws
 *  something rather than an empty disc. */
export function baseInitial(name: string): string {
  const cs = chars(name)
  const i = cs.findIndex((c) => /[\p{L}\p{N}]/u.test(c))
  return (i >= 0 ? cs[i] : cs[0] ?? '?').toLocaleUpperCase()
}

/** True for a full-width / CJK grapheme, which is a far denser glyph than a Latin capital and
 *  paints past the 24px disc at 11px. The caller drops it to 9. */
export function isWideGrapheme(s: string): boolean {
  return /[　-鿿가-힯＀-￯]/.test(s)
}

/** Every lane's initial, keyed by id. `id` is whatever the caller uses to look one up (a role id,
 *  a session id) and only has to be unique within the list. */
export function resolveLaneInitials(lanes: { id: string; name: string }[]): Record<string, string> {
  const out: Record<string, string> = {}
  const cs = lanes.map((l) => chars(l.name))
  const bases = lanes.map((l) => baseInitial(l.name))

  lanes.forEach((lane, i) => {
    const peers = lanes
      .map((_, j) => j)
      .filter((j) => j !== i && bases[j] === bases[i])
    if (!peers.length) { out[lane.id] = bases[i]; return }
    // THE CHARACTER WHERE THIS NAME DIVERGES FROM EVERY COLLIDING PEER — not from the nearest one.
    //
    // Design's rule reads "the character where the two names diverge", which is exact for a PAIR
    // and ambiguous for three. Taking the nearest peer's divergence (the proposal's own script
    // does) gives Research/Review/Rollback → RE / RE / RO: the two names the rule exists to
    // separate come out identical. Requiring the character to differ from ALL of them gives
    // RS / RV / RO, and for a pair it is the same computation — so this generalises the rule
    // rather than replacing it.
    let k = -1
    for (let n = 0; n < cs[i].length; n++) {
      const mine = cs[i][n].toLocaleUpperCase()
      if (peers.every((j) => cs[j][n]?.toLocaleUpperCase() !== mine)) { k = n; break }
    }
    // No such character: an identical name, or one that is a prefix of its peer. Both fall to the
    // index below, which is the only honest tie-break left.
    out[lane.id] = k >= 0 ? bases[i] + cs[i][k].toLocaleUpperCase() : bases[i]
  })

  // THE GUARANTEE. Anything still tied — identical names, a name that is a prefix of its peer, or
  // an exotic three-way where no single character separates all of them — takes its position in
  // the roster instead. `Review` × 2 → `R1` / `R2`. Ordinal, so it is stable for as long as the
  // roster order is, which is the same contract the rest of the strip already keeps.
  const byInitial = new Map<string, string[]>()
  for (const lane of lanes) {
    const k = out[lane.id]
    byInitial.set(k, [...(byInitial.get(k) ?? []), lane.id])
  }
  for (const [, ids] of byInitial) {
    if (ids.length < 2) continue
    ids.forEach((id, n) => {
      const lane = lanes.find((l) => l.id === id)!
      out[id] = baseInitial(lane.name) + String(n + 1)
    })
  }
  return out
}
