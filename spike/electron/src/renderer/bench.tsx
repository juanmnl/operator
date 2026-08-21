// The measurement harness — M1 (renderer verdict) and M2 (memory at fleet shape).
//
// It mounts the SHIPPED `TerminalPane` over REAL ptys. That is the point: an xterm fed from a
// string in a loop would answer a question nobody asked. The WebGL/DOM choice is passed as the
// pane's own `webgl` prop, which already exists for exactly this purpose — so nothing under
// `src/` needs editing to run the comparison.
//
// M2 NEEDS A FILL PHASE, AND THIS COST ONE RUN TO LEARN. Mounting 27 panes and streaming into
// two of them measures almost nothing: `TerminalPane` does not write to xterm while it is
// hidden — output goes to `bgBufferRef` (capped at 512KB) and is flushed only when the pane
// becomes visible. So a lane the user has never looked at holds an EMPTY xterm buffer, and the
// 27 mounted terminals cost a rounding error. The app's real shape comes from lanes that HAVE
// been looked at: each filled its 10,000-line active buffer, then was trimmed to 2,000 on
// switch-away and kept them. The fill phase below reproduces that by rotating `active` across
// every lane before settling — which is also, incidentally, a finding worth reporting on its
// own.
//
//   ?renderer=webgl|dom   which xterm renderer (default dom, what ships)
//   ?lanes=N              how many panes to mount (M2 uses 27)
//   ?stream=N             how many keep streaming after the fill phase
//   ?fill=1               rotate `active` across every lane first (M2); off for M1
//   ?dwell=15000          ms spent on each lane during the fill rotation
//   ?claude=1             lane 0 is a REAL `claude` session instead of a replay (M1)
//   ?cwd=/path            where lanes are spawned (default: this repo)
import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { installSpikeBridge } from './bridge'
import { TerminalPane } from '../../../../src/renderer/components/terminal/TerminalPane'
import '../../../../src/renderer/styles.css'

const q = new URLSearchParams(location.search)
const WEBGL = q.get('renderer') === 'webgl'
const LANES = Math.max(1, Number(q.get('lanes') ?? 1))
const STREAM = Math.max(0, Number(q.get('stream') ?? 1))
const FILL = q.get('fill') === '1'
const DWELL = Math.max(1000, Number(q.get('dwell') ?? 15000))
const LIVE_CLAUDE = q.get('claude') === '1'
const CWD = q.get('cwd') ?? '/Users/juanmnl/.operator/worktrees/operator-c25838'
const REPLAY = q.get('replay') ?? `${CWD}/scripts/width-audit/claude-turn.bin`

/** Matches the app's dark terminal palette closely enough that a colour fault reads as a fault
 *  rather than as "the bench looks different". */
const THEME = { background: '#0b0d10', foreground: '#e6e6e6', cursor: '#e6e6e6' }

/** A REAL pty writing the captured bytes on a loop — the same capture the width-audit
 *  harnesses use, so the byte stream under test is the one Claude Code actually produces,
 *  including the absolute-column redraws that cause the overprint. */
const replayLoop = (id: string) =>
  window.operator.terminalWrite(id, `while true; do cat ${REPLAY}; sleep 0.05; done\r`)

const stopLoop = (id: string) => window.operator.terminalWrite(id, '\x03')

function Bench() {
  const [ids, setIds] = useState<string[]>([])
  const [activeIdx, setActiveIdx] = useState(0)
  const [phase, setPhase] = useState<'spawning' | 'filling' | 'settled'>('spawning')
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    void (async () => {
      const out: string[] = []
      for (let i = 0; i < LANES; i++) {
        if (i === 0 && LIVE_CLAUDE) {
          const r = await window.operator.terminalSpawn(CWD, {})
          if (r) out.push(r.terminalId)
          continue
        }
        out.push(await window.operator.shellSpawn(CWD))
      }
      setIds(out)
      const note = (extra: Record<string, unknown>) => {
        ;(window as unknown as Record<string, unknown>).__bench = {
          renderer: WEBGL ? 'webgl' : 'dom', lanes: LANES, streaming: STREAM,
          liveClaude: LIVE_CLAUDE, fill: FILL, startedAt: new Date().toISOString(), ids: out, ...extra,
        }
      }
      note({ phase: 'spawning' })

      if (FILL) {
        // Every lane streams during the fill so each one has something to accumulate, and
        // `active` walks across them so each actually WRITES it into xterm.
        setPhase('filling')
        note({ phase: 'filling' })
        out.forEach(replayLoop)
        for (let i = 0; i < out.length; i++) {
          setActiveIdx(i)
          await new Promise((r) => setTimeout(r, DWELL))
        }
        // Settle: all but the first `STREAM` lanes go quiet, holding the 2,000 trimmed lines
        // they were left with — which is the resting fleet this measurement is about.
        out.slice(STREAM).forEach(stopLoop)
        setActiveIdx(0)
      } else {
        out.slice(0, STREAM).forEach(replayLoop)
      }
      setPhase('settled')
      note({ phase: 'settled', settledAt: new Date().toISOString() })
    })()
  }, [])

  // Exactly one pane is `active`, so every other one holds INACTIVE_SCROLLBACK (2,000) just as
  // a background lane does in the app. Making them all active would measure 27 foreground
  // panes, which is not a shape the product ever has.
  const cols = Math.ceil(Math.sqrt(ids.length || 1))
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'grid', gap: 2, background: '#000',
                  gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
      {ids.map((id, i) => (
        <div key={id} style={{ position: 'relative', overflow: 'hidden' }} data-phase={phase}>
          <TerminalPane terminalId={id} theme={THEME} active={i === activeIdx} webgl={WEBGL} />
        </div>
      ))}
    </div>
  )
}

installSpikeBridge()
createRoot(document.getElementById('root')!).render(<Bench />)
