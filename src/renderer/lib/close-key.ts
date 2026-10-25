import { isMidTurn } from './project-shelf'

/** ⌘W armed on a lane: which one, and until when. */
export interface CloseKeyArm { terminalId: string; until: number }

/** What a ⌘W press does to the active lane: close it, arm and say so, or nothing.
 *
 *  A lane mid-turn arms on the first press, because closing forgets its saved session and the
 *  turn is lost with no resume offered. A second press on the same lane before `until` closes.
 *  An idle, waiting or ended lane closes on the first press, as it always did.
 *
 *  AN AUTO-REPEAT IS NOT A PRESS (review R1, 2026-10-24). macOS repeats a held ⌘W after a few
 *  hundred milliseconds, well inside the arm window, so holding it slightly too long armed and
 *  closed a mid-turn lane in one gesture. A repeat after a close would also close the lane that
 *  became active next. */
export function closeKeyAction(
  lane: { terminalId: string; status: string; phase: string },
  armed: CloseKeyArm | null,
  now: number,
  repeat = false,
): 'close' | 'arm' | 'ignore' {
  if (repeat) return 'ignore'
  if (lane.status === 'ended' || !isMidTurn(lane.phase)) return 'close'
  return armed && armed.terminalId === lane.terminalId && now < armed.until ? 'close' : 'arm'
}

/** ONE CLOSE PER LANE, whoever asks (review R2, 2026-10-24). Keyed by terminal id. The rail ■, ⌘W,
 *  the Team card, the palette, the project close and its Retry all go through `run`, so a second
 *  ask while a close is still stopping a slow pty gets that close instead of starting another:
 *  two WIP snapshots raced on one folder, and the second removal reported a folder it could not
 *  find. A close can be filed under a second id (`alias`), for a suspended lane closed under the id
 *  of the lane its resume brought back (review R3); `closedAs` answers which. */
export class LaneCloses<R> {
  private readonly running = new Map<string, Promise<R>>()
  private readonly aliases = new Map<string, string>()

  /** The close running for `id`, or the one `start` begins, filed under `id` until it settles.
   *  `start` gets a function that files the same close under another id too. */
  run(id: string, start: (alias: (other: string) => void) => Promise<R>): Promise<R> {
    const found = this.running.get(id)
    if (found) return found
    const others: string[] = []
    let close!: Promise<R>
    // `alias` is only called after `start` has awaited something, so `close` is set by then; filed
    // at once when it is not.
    const alias = (other: string) => {
      others.push(other)
      this.aliases.set(id, other)
      if (close) this.running.set(other, close)
    }
    close = start(alias)
    for (const other of others) this.running.set(other, close)
    this.running.set(id, close)
    const drop = () => {
      for (const k of [id, ...others]) if (this.running.get(k) === close) this.running.delete(k)
    }
    void close.then(drop, drop)
    return close
  }

  /** The other id a close for `id` was filed under, if any. Kept after it settles, for the project
   *  close's check after its time bound; `forget` drops it. */
  closedAs(id: string): string | undefined {
    return this.aliases.get(id)
  }

  forget(id: string): void {
    this.aliases.delete(id)
  }
}
