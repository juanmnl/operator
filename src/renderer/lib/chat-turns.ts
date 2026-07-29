import type { NarrationEntry } from '../../shared/types'
import { isInjectedTurn } from './format'

// Which narration entries the reading surface may render.
//
// The `thinking` rule is the load-bearing one. Claude Code emits thinking blocks that carry a
// `signature` and NO text — the reasoning is redacted at source. Measured across 326 real
// transcripts in ~/.claude/projects: 17,682 thinking blocks, 17,682 empty, zero with text.
// So a collapsible "Thought ▸" disclosure can never open, and a control that does nothing when
// clicked is worse than no control.
//
// The parse path stays — an empty one simply renders NOTHING, so the block lights up on its own
// if Claude Code ever starts emitting real thinking text. What it must not do is render an
// empty disclosure.

export function isRenderableTurn(m: NarrationEntry): boolean {
  if (m.kind === 'thinking') return m.text.trim().length > 0
  if (m.kind === 'user') return !isInjectedTurn(m.text)
  // Tool calls ARE the action stream — the honest carrier of "what the agent did", and the
  // one the empty `thinking` blocks were standing in for.
  if (m.kind === 'tool') return !!m.tool
  return m.kind === 'text'
}
