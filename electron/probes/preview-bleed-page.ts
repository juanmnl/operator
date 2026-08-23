// The harness page: the app's Preview topology, reduced to the parts that composite.
//
//   terminals block (position:relative)
//     └ pane (position:absolute inset:0, visibility: visible | hidden)   ← REAL xterm, with text
//     └ overlay (position:absolute inset:0, background)                  ← later in DOM = on top
//         └ stage (#fff)
//             └ <iframe src=CROSS-ORIGIN>                                ← an OOPIF in Chromium
//
// Nothing here is a mock of the mechanism under test: the terminal is the real xterm DOM
// renderer the app uses, the iframe is genuinely cross-origin (a different port IS a different
// origin), and the page is loaded from `file://` exactly as the packaged app's renderer is.
import { Terminal } from '@xterm/xterm'

const q = new URLSearchParams(location.search)
const target = q.get('target') ?? 'about:blank'
/** `visible` reproduces today's DashboardView (only INACTIVE panes are hidden); `hidden` is the
 *  proposed fix (the active pane hides too while an overlay covers it). */
const paneVisibility = (q.get('pane') ?? 'visible') as 'visible' | 'hidden'

const root = document.getElementById('root')!
root.style.cssText = 'position:relative;width:900px;height:520px;background:#0b0d10'

const pane = document.createElement('div')
pane.id = 'pane'
pane.style.cssText = `position:absolute;inset:0;visibility:${paneVisibility}`
root.appendChild(pane)

const term = new Terminal({
  rows: 24, cols: 100, fontSize: 13,
  // MAGENTA on purpose: the witness colour must be one that neither the framed page nor the
  // stage can produce, or a green-ish app would be indistinguishable from a bleeding selection.
  theme: { background: '#0b0d10', foreground: '#c9d4c5', selectionBackground: '#ff00ff' },
})
term.open(pane)
// The line the user actually saw bleeding through, and a selection on it — the highlight is the
// brightest thing in the pane, so it is what a pixel check can find unambiguously.
term.write('OPERATOR-DISPATCH [code] Electron Preview: the dev-server iframe paints solid black\r\n')
term.write('and the active terminal shows THROUGH it — reproduce with capturePage.\r\n')
setTimeout(() => term.selectLines(0, 1), 100)

const overlay = document.createElement('div')
overlay.id = 'overlay'
overlay.style.cssText = 'position:absolute;inset:0;border-radius:12px;overflow:hidden;background:#11151a'
root.appendChild(overlay)

const stage = document.createElement('div')
stage.id = 'stage'
stage.setAttribute('data-preview-stage', '')
stage.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;background:#fff'
overlay.appendChild(stage)

const frame = document.createElement('iframe')
frame.src = target
frame.title = 'App preview'
frame.style.cssText = 'width:100%;height:100%;border:none'
stage.appendChild(frame)
