// THROWAWAY perf spike (dev/webgl-terminal-in-wkwebview.md) — quantifies the DOM
// renderer's cost instead of assuming it: (1) frame delivery during a heavy write burst
// (a "fast-scrolling build log"), (2) frame delivery during a scroll-fling over deep
// scrollback, (3) the scrollback depth actually reached. Same real captured stream +
// production xterm config as the other width-audit harnesses.
import { Terminal } from '@xterm/xterm'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
import { stripOrnaments } from '../../src/renderer/lib/terminal'

const COLS = 100, ROWS = 30
const term = new Terminal({
  cols: COLS, rows: ROWS, scrollback: 10000, allowProposedApi: true,
  theme: { background: '#0b0d10', foreground: '#d7d7de' },
})
term.loadAddon(new UnicodeGraphemesAddon())
term.unicode.activeVersion = '15-graphemes'
term.open(document.getElementById('term')!)

const write = (s: string) => new Promise<void>((res) => term.write(s, () => res()))

// A free-running rAF counter — sampled over fixed wall-clock windows to get an actual
// "frames delivered per second" figure, comparable to the 60fps a live compositor targets.
let rafCount = 0
function pump() { rafCount++; requestAnimationFrame(pump) }
requestAnimationFrame(pump)

function sampleFps(ms: number): Promise<number> {
  return new Promise((res) => {
    const start = rafCount
    setTimeout(() => res(((rafCount - start) / ms) * 1000), ms)
  })
}

const LOOPS = Number(new URLSearchParams(location.search).get('loops') || '200')

async function run() {
  const buf = new Uint8Array(await (await fetch('./claude-turn.bin')).arrayBuffer())
  const text = stripOrnaments(new TextDecoder().decode(buf))
  const CHUNK = 256
  const totalChars = text.length * LOOPS

  // Idle baseline — what this machine/WebKit delivers with nothing happening, so the
  // write/scroll numbers below have something honest to be a percentage OF.
  const idleFps = await sampleFps(500)

  // Heavy write burst: replay the real stream back-to-back as fast as xterm will take
  // it (no artificial pacing) — the closest single-terminal approximation of "a build
  // log scrolling fast" available without a live pty.
  const writeStart = performance.now()
  const rafAtWriteStart = rafCount
  for (let loop = 0; loop < LOOPS; loop++) {
    for (let i = 0; i < text.length; i += CHUNK) await write(text.slice(i, i + CHUNK))
  }
  const writeMs = performance.now() - writeStart
  const writeFps = ((rafCount - rafAtWriteStart) / writeMs) * 1000

  const scrollbackLines = term.buffer.active.length

  // Scroll-fling: from the bottom, scroll to top in small steps across consecutive
  // frames (mimics a fast trackpad fling), then back down — over deep scrollback.
  const flingStart = performance.now()
  const rafAtFlingStart = rafCount
  const totalLines = term.buffer.active.length
  const STEPS = 120
  for (let s = 0; s < STEPS; s++) {
    term.scrollLines(-Math.ceil(totalLines / STEPS))
    await new Promise<void>((res) => requestAnimationFrame(() => res()))
  }
  for (let s = 0; s < STEPS; s++) {
    term.scrollLines(Math.ceil(totalLines / STEPS))
    await new Promise<void>((res) => requestAnimationFrame(() => res()))
  }
  const flingMs = performance.now() - flingStart
  const flingFps = ((rafCount - rafAtFlingStart) / flingMs) * 1000

  ;(window as unknown as { __perf: unknown }).__perf = {
    idleFps: Math.round(idleFps * 10) / 10,
    writeFps: Math.round(writeFps * 10) / 10,
    flingFps: Math.round(flingFps * 10) / 10,
    writeMs: Math.round(writeMs),
    flingMs: Math.round(flingMs),
    loops: LOOPS,
    totalChars,
    charsPerSec: Math.round(totalChars / (writeMs / 1000)),
    scrollbackLines,
  }
  ;(window as unknown as { __perfReady: boolean }).__perfReady = true
}
void run()
