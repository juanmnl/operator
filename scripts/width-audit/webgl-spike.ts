// THROWAWAY spike (dev/webgl-terminal-in-wkwebview.md) — does xterm's WebGL renderer
// corrupt under Playwright WebKit the way it's recorded corrupting in the app's WKWebView?
//
// Loads the SAME real captured Claude turn dom-vs-buffer.ts uses, through WebGL instead
// of DOM, chunked like real pty delivery, and LOOPED many times back-to-back — a single
// pass is already on record as "looked clean" in an earlier spot-test; the recorded
// failure only showed up over a sustained session of repeated in-place redraws.
import { Terminal } from '@xterm/xterm'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
import { WebglAddon } from '@xterm/addon-webgl'
import { stripOrnaments } from '../../src/renderer/lib/terminal'

const COLS = 100, ROWS = 30
const term = new Terminal({
  cols: COLS, rows: ROWS, scrollback: 10000, allowProposedApi: true,
  theme: { background: '#0b0d10', foreground: '#d7d7de' },
})
term.loadAddon(new UnicodeGraphemesAddon())
term.unicode.activeVersion = '15-graphemes'
term.open(document.getElementById('term')!)

// Diagnostic: does this WebKit even hand out a WebGL context at all? Headless browsers
// sometimes disable GPU compositing entirely, which would produce a blank canvas that
// looks like corruption but is actually a test-harness limitation, not a WKWebView finding.
const probe = document.createElement('canvas')
const gl2 = probe.getContext('webgl2')
const gl1 = !gl2 && probe.getContext('webgl')
const glInfo = { webgl2: !!gl2, webgl1: !!gl1 }

const useWebgl = new URLSearchParams(location.search).get('renderer') !== 'dom'
let webglOk = true
let webglError = ''
let atlasEvents = 0
let atlasCanvasSize = ''
if (useWebgl) {
  try {
    // preserveDrawingBuffer:true — otherwise a screenshot taken outside the exact draw
    // frame can read an already-cleared backbuffer and look blank for reasons that have
    // nothing to do with corruption (a harness artifact, not a WKWebView finding).
    const webgl = new WebglAddon(true)
    webgl.onContextLoss(() => { webglOk = false; webglError = 'context lost' })
    webgl.onChangeTextureAtlas((canvas) => {
      atlasEvents++
      atlasCanvasSize = `${canvas.width}x${canvas.height}`
    })
    term.loadAddon(webgl)
  } catch (e) {
    webglOk = false
    webglError = String(e)
  }
}
;(window as unknown as { __glInfo: unknown }).__glInfo = glInfo
;(window as unknown as { __atlasInfo: unknown }).__atlasInfo = () => ({
  atlasEvents, atlasCanvasSize,
  glCanvas: (() => {
    const c = document.querySelector('#term canvas.xterm-gl-canvas, #term canvas') as HTMLCanvasElement | null
    return c ? `${c.width}x${c.height} style=${c.style.width}x${c.style.height}` : 'NO CANVAS FOUND'
  })(),
  termEl: (() => {
    const el = document.getElementById('term')
    return el ? `${el.clientWidth}x${el.clientHeight}` : 'no #term'
  })(),
})

const write = (s: string) => new Promise<void>((res) => term.write(s, () => res()))
const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms))

const LOOPS = Number(new URLSearchParams(location.search).get('loops') || '40')

async function run() {
  const buf = new Uint8Array(await (await fetch('./claude-turn.bin')).arrayBuffer())
  const text = stripOrnaments(new TextDecoder().decode(buf))
  const CHUNK = 256

  for (let loop = 0; loop < LOOPS && webglOk; loop++) {
    for (let i = 0; i < text.length; i += CHUNK) {
      await write(text.slice(i, i + CHUNK))
      await sleep(2)
    }
    // Mimic real turns landing back-to-back, not one continuous blast.
    await sleep(15)
    ;(window as unknown as { __loopsDone: number }).__loopsDone = loop + 1
    if (loop === 0) {
      await new Promise<void>((res) => requestAnimationFrame(() => requestAnimationFrame(() => res())))
      ;(window as unknown as { __loop1Ready: boolean }).__loop1Ready = true
    }
  }

  await new Promise<void>((res) => requestAnimationFrame(() => requestAnimationFrame(() => res())))
  ;(window as unknown as { __webglSpikeReady: boolean }).__webglSpikeReady = true
  ;(window as unknown as { __webglOk: boolean; __webglError: string }).__webglOk = webglOk
  ;(window as unknown as { __webglOk: boolean; __webglError: string }).__webglError = webglError
}
void run()
