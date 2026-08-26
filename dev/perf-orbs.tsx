import { createRoot } from 'react-dom/client'
import { StatusWave, type WaveStatus } from '../src/renderer/components/sidebar/StatusWave'
import '../src/renderer/styles.css'

// THE ORB BENCH. `?n=7&status=running&size=24` renders that many real orbs, each with its own
// seed and lane accent, on a bare page.
//
// WHY NOT THE MOCK APP: the question is what the twinkle costs, and `dev/mock.html` runs a
// terminal, a transcript feed and a whole sidebar next to it — noise that is not being changed
// and that swamps a 2-3% delta. The orbs here are the SAME component, the same stylesheet and
// the same geometry the rail draws, so a before/after on this page is a clean read on the
// keyframe. It is not a claim about total app CPU.
// THE TOKENS THE ORB READS, applied here because this page has no ThemeProvider. Without them
// `--fg-muted` and friends are undefined, `fill: var(--tw-fill, var(--fg-muted))` is invalid at
// computed-value time, and the dots paint a fallback colour nobody ships — which would make both
// the screenshots and the paint cost a measurement of the wrong thing. Mission Control dark,
// copied from `themes/mission-control.ts`.
const MC_DARK: Record<string, string> = {
  '--bg-sidebar': '#07090b', '--fg': '#e6eaf0', '--fg-muted': '#8a94a0',
  '--green': '#7ee787', '--yellow': '#ffd43b',
  '--status-running': '#7ee787', '--status-compacting': '#ffd43b',
}
for (const [k, v] of Object.entries(MC_DARK)) document.documentElement.style.setProperty(k, v)

const q = new URLSearchParams(location.search)
const n = Number(q.get('n') ?? 7)
const status = (q.get('status') ?? 'running') as WaveStatus
const size = Number(q.get('size') ?? 24)

// The default lane accents, so the peak half is tinted exactly as a real rail's is.
const ACCENTS = ['#7dd3a0', '#8ab4f8', '#f7a8c4', '#f6c177', '#b39ddb', '#79d0d8', '#e5989b']

function Bench() {
  return (
    <div style={{ display: 'flex', gap: 12, padding: 16, background: 'var(--bg-sidebar, #111)' }}>
      {Array.from({ length: n }, (_, i) => (
        <StatusWave key={i} status={status} size={size} seed={`lane-${i}`} accent={ACCENTS[i % ACCENTS.length]} />
      ))}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Bench />)
