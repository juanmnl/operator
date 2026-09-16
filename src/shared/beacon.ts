// The ASKING beacon: the flash an orb and the tray icon show while a lane has a question open for
// the user. Shared by the renderer (sidebar/StatusWave) and the main process (tray-anim), so the
// rail and the menu bar flash on the same rhythm. Pure.
//
// WHY IT LOOKS NOTHING LIKE `running`. The running twinkle is desynced: every dot breathes on its
// own period and offset, so at any instant roughly half the disc is lit and the total ink barely
// moves. The beacon is the opposite on both axes the eye uses to tell motion apart:
//   • UNISON: every dot rises and falls together, so the whole disc switches on and off.
//   • A REST GAP: after each flash the disc sits dark (at rest level) for most of a second. The
//     twinkle never rests, so a gap in the motion is itself the signal.
// It never settles while the question is open. The retired your-turn pulse settled after 6s
// because "your turn" is an invitation; an open question is a blocker, and the lane cannot move
// until it is answered.

/** One flash every 1.5s. */
export const BEACON_PERIOD_S = 1.5
/** Rise to full in 120ms, eased out: a flash, not a breath. */
export const BEACON_ATTACK_S = 0.12
/** Fall back over 450ms, eased in. The remaining 0.93s is the rest gap. */
export const BEACON_DECAY_S = 0.45

/** How lit the beacon is at `elapsed` seconds: 0 at rest, 1 at the top of the flash.
 *
 *  A function of ABSOLUTE time, so every asking orb in the rail (and the tray) flashes in step
 *  with every other one, and an orb that leaves the frame loop rejoins at the right phase. */
export function beaconLevel(elapsed: number): number {
  const t = ((elapsed % BEACON_PERIOD_S) + BEACON_PERIOD_S) % BEACON_PERIOD_S
  if (t < BEACON_ATTACK_S) {
    const u = t / BEACON_ATTACK_S
    return 1 - (1 - u) * (1 - u)
  }
  if (t < BEACON_ATTACK_S + BEACON_DECAY_S) {
    const u = (t - BEACON_ATTACK_S) / BEACON_DECAY_S
    return (1 - u) * (1 - u)
  }
  return 0
}
