// Subtle synthesized UI chimes (Web Audio). Tones are generated, not sampled, so
// there are no asset files to bundle — they're tiny, easy to tune, and stay "cute".
// Currently one cue: the your-turn chime, played when a session finishes its turn
// and is waiting on you. Off by default; toggled in Operator preferences.

const ENABLED_KEY = 'operator.soundsEnabled'

export function soundsEnabled(): boolean {
  try { return localStorage.getItem(ENABLED_KEY) === '1' } catch { return false }
}

export function setSoundsEnabled(on: boolean): void {
  try { localStorage.setItem(ENABLED_KEY, on ? '1' : '0') } catch { /* ignore */ }
}

let ctx: AudioContext | null = null
function audioCtx(): AudioContext | null {
  try {
    if (!ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AC) return null
      ctx = new AC()
    }
    // Autoplay policy starts the context "suspended" until a user gesture; resume so
    // the next cue is audible (unlocked on the first pointerdown, see below).
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  } catch { return null }
}

// One soft note: a sine with a quick attack and a gentle exponential decay so it
// reads as a rounded "ding" rather than a beep. exponentialRamp can't reach 0, so
// we floor at a near-silent value.
function note(ac: AudioContext, freq: number, start: number, dur: number, peak: number) {
  const osc = ac.createOscillator()
  const gain = ac.createGain()
  osc.type = 'sine'
  osc.frequency.value = freq
  osc.connect(gain).connect(ac.destination)
  const t = ac.currentTime + start
  gain.gain.setValueAtTime(0.0001, t)
  gain.gain.exponentialRampToValueAtTime(peak, t + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  osc.start(t)
  osc.stop(t + dur + 0.02)
}

/** A gentle rising two-note chime — "your turn". Deliberately quiet so it never
 *  startles; a soft B5 → E6 (a friendly rising fourth). No-op when sounds are off. */
export function playYourTurnChime(): void {
  if (!soundsEnabled()) return
  const ac = audioCtx()
  if (!ac) return
  note(ac, 987.77, 0, 0.5, 0.06)       // B5
  note(ac, 1318.51, 0.085, 0.55, 0.05) // E6
}

// Unlock the AudioContext on the first user gesture so the first real cue isn't
// swallowed by the browser autoplay policy. Idempotent; runs once on import.
if (typeof window !== 'undefined') {
  const unlock = () => { audioCtx() }
  window.addEventListener('pointerdown', unlock, { once: true })
}
