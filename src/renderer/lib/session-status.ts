import type { WaveStatus } from '../components/sidebar/StatusWave'

// Map a session's status/phase to the status-wave indicator. Single definition
// for the sidebar item, the activity dashboard, and anywhere else that shows a
// session dot (previously copy-pasted in each). `ended` wins over any phase.
export function sessionWaveStatus(session: { status: string; phase: string }): WaveStatus {
  if (session.status === 'ended') return 'ended'
  switch (session.phase) {
    case 'running': return 'running'
    case 'compacting': return 'compacting'
    case 'waiting': return 'waiting'
    default: return 'idle'
  }
}
