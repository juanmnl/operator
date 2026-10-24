import { isMidTurn } from './project-shelf'

/** ⌘W armed on a lane: which one, and until when. */
export interface CloseKeyArm { terminalId: string; until: number }

/** What a ⌘W press does to the active lane: close it, or arm and say so.
 *
 *  A lane mid-turn arms on the first press, because closing forgets its saved session and the
 *  turn is lost with no resume offered. A second press on the same lane before `until` closes.
 *  An idle, waiting or ended lane closes on the first press, as it always did. */
export function closeKeyAction(
  lane: { terminalId: string; status: string; phase: string },
  armed: CloseKeyArm | null,
  now: number,
): 'close' | 'arm' {
  if (lane.status === 'ended' || !isMidTurn(lane.phase)) return 'close'
  return armed && armed.terminalId === lane.terminalId && now < armed.until ? 'close' : 'arm'
}
