import { describe, it, expect } from 'vitest'
import { derivePhase, isInjectedTurn, toolResultText, userPromptText, COMPACTING_CEILING_MS, sendMessageAddress, Track } from './transcript'

describe('derivePhase', () => {
  it('is running while a tool is open', () => {
    expect(derivePhase(true, null, false, false)).toBe('running')
  })
  it('is running when the last stop was a tool_use — the turn has more to do', () => {
    expect(derivePhase(false, 'tool_use', false, false)).toBe('running')
  })
  it('is running right after a user prompt, before the response starts', () => {
    expect(derivePhase(false, null, true, false)).toBe('running')
  })
  it('is waiting once the turn ended and nothing is open', () => {
    expect(derivePhase(false, 'end_turn', false, false)).toBe('waiting')
  })
  it('is COMPACTING between the boundary and the next assistant record', () => {
    expect(derivePhase(false, 'end_turn', false, true)).toBe('compacting')
  })
  it('lets compacting outrank a tool left open from before the boundary', () => {
    // Compaction has already dropped that tool's result, so `running` off it is a signal that
    // stopped being true. Matches `derive_phase_compacting_outranks_a_stale_open_tool` in Rust.
    expect(derivePhase(true, 'tool_use', true, true)).toBe('compacting')
  })
})

describe('isInjectedTurn', () => {
  it('recognises the turns Claude Code injects', () => {
    for (const p of ['<local-command-stdout>x', '<command-name>/foo', '<system-reminder>hi', '<task-notification>done', '<synthetic>x']) {
      expect(isInjectedTurn(p), p).toBe(true)
    }
  })
  it('tolerates leading whitespace', () => {
    expect(isInjectedTurn('\n  <system-reminder>x')).toBe(true)
  })
  it('leaves a real prompt alone', () => {
    expect(isInjectedTurn('fix the login button')).toBe(false)
    // A prompt that merely MENTIONS a tag is not injected.
    expect(isInjectedTurn('what does <system-reminder> mean?')).toBe(false)
  })
})

// Storing the raw JSON here kept about a third of real results as `[{"type":"text",...}]`
// instead of the output — the transcript showed the wrapper, not the answer.
describe('toolResultText', () => {
  it('passes a plain string through', () => {
    expect(toolResultText('hello')).toBe('hello')
  })
  it('FLATTENS an array of blocks to their text', () => {
    expect(toolResultText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb')
  })
  it('is empty for null/undefined', () => {
    expect(toolResultText(null)).toBe('')
    expect(toolResultText(undefined)).toBe('')
  })
})

describe('userPromptText', () => {
  it('reads a plain string prompt', () => {
    expect(userPromptText('do the thing')).toBe('do the thing')
  })
  it('joins text blocks', () => {
    expect(userPromptText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('ab')
  })
  it('returns null for a tool_result turn — same `user` type, not a prompt', () => {
    expect(userPromptText([{ type: 'tool_result', tool_use_id: 't1', content: 'out' }])).toBeNull()
  })
  it('returns null for whitespace-only content', () => {
    expect(userPromptText([{ type: 'text', text: '   ' }])).toBeNull()
  })
})

describe('COMPACTING_CEILING_MS', () => {
  it('is five minutes — past the longest real compaction, which measured 134s', () => {
    // A boundary with nothing after it must not wedge the lane forever, and the ceiling is how
    // that is bounded. Kept equal to the Rust constant of the same name.
    expect(COMPACTING_CEILING_MS).toBe(5 * 60_000)
  })
})

describe('sendMessageAddress', () => {
  // The rule that decides whether a bus dispatch ever gets a delivery confirmation. Getting it
  // wrong is silent in both directions: too narrow and the task stays marked running with nobody
  // able to tell nothing was sent; too broad and an unrelated tool result confirms a delivery
  // that never happened.
  it('reads the address off a SendMessage call', () => {
    expect(sendMessageAddress('SendMessage', { to: 'uds:/tmp/cc-socks/2001.sock', message: 'go' }))
      .toBe('uds:/tmp/cc-socks/2001.sock')
  })

  it('accepts a plain agent name too — `to` is free-form and Operator does not own it', () => {
    expect(sendMessageAddress('SendMessage', { to: 'review' })).toBe('review')
  })

  it('ignores EVERY other tool, so no unrelated result can confirm a dispatch', () => {
    for (const name of ['Bash', 'Read', 'Task', 'sendmessage', 'SendMessages']) {
      expect(sendMessageAddress(name, { to: 'uds:/tmp/x.sock' })).toBeNull()
    }
  })

  it('returns null for a call with no usable address rather than an empty key', () => {
    // An empty string would collide with every other empty one in the pending map.
    for (const input of [null, undefined, {}, { to: '' }, { to: '   ' }, { to: 42 }, 'not an object']) {
      expect(sendMessageAddress('SendMessage', input)).toBeNull()
    }
  })
})

describe('contextTokens — the MAIN thread only', () => {
  // Review's HIGH on the plan bar, and it is the same defect in both tailers: the cumulative
  // usage totals SHOULD count a subagent's tokens, because they were really spent, but
  // `contextTokens` is a reading of the main thread's prompt and a subagent starts near-empty.
  // Unguarded, a 15k sidechain turn overwrote a 780k reading — so the bar emptied at the exact
  // moment the lane was closest to compacting, which is when the reading matters most.
  const track = () => new Track('t0', {
    claudeSessionId: 's0', cwd: '/tmp', permissionMode: null, projectId: 'p1',
  })
  const rec = (id: string, isSidechain: boolean, cacheRead: number) => ({
    type: 'assistant', isSidechain, timestamp: '2026-09-06T10:00:00.000Z',
    message: {
      id, role: 'assistant', model: 'claude-opus-4', stop_reason: 'end_turn', content: [],
      usage: {
        input_tokens: 0, cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: 0, output_tokens: 5,
      },
    },
  })

  it('a sidechain turn does not overwrite the main thread\'s reading', () => {
    const t = track()
    t.apply(rec('m1', false, 780_000))
    expect(t.contextTokens).toBe(780_000)

    t.apply(rec('m2', true, 15_000))
    expect(t.contextTokens).toBe(780_000)
  })

  it('still COUNTS the subagent\'s spend — that is the difference between the two numbers', () => {
    const t = track()
    t.apply(rec('m1', false, 780_000))
    t.apply(rec('m2', true, 15_000))
    expect(t.usage.cacheRead).toBe(795_000)
  })

  it('keeps following the main thread afterwards', () => {
    const t = track()
    t.apply(rec('m1', false, 780_000))
    t.apply(rec('m2', true, 15_000))
    t.apply(rec('m3', false, 790_000))
    expect(t.contextTokens).toBe(790_000)
  })
})

// The newest WORK prompt, stamped when the lane TOOK IT UP: main cancels a `worktree_done` release
// that new work arrived after (index.ts, `cancelReleasesBefore`). Review 2026-09-27, H1 and round 2
// (R2-2, R2-3). Record shapes are taken from real transcripts (2026-09-25/27): an idle lane writes
// enqueue → dequeue (no content) → user; a mid-turn lane writes enqueue → … → remove (with the
// content) → a `queued_command` attachment.
describe('Track.lastPromptAt', () => {
  const track = () => new Track('t0', { claudeSessionId: 's0', cwd: '/tmp', permissionMode: null, projectId: 'p1' })
  const user = (text: string, timestamp: string, extra: Record<string, unknown> = {}) =>
    ({ type: 'user', timestamp, message: { role: 'user', content: text }, ...extra })
  const q = (operation: string, timestamp: string, content?: string) =>
    ({ type: 'queue-operation', operation, timestamp, sessionId: 's0', ...(content === undefined ? {} : { content }) })
  const bus = (inner: string) => `<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="p--operator" from-mode="prompting">\n${inner}\n</cross-session-message>`

  it('is the newest real user turn', () => {
    const t = track()
    t.apply(user('first', '2026-09-27T10:00:00.000Z'))
    t.apply(user('second', '2026-09-27T10:05:00.000Z'))
    expect(t.lastPromptAt).toBe('2026-09-27T10:05:00.000Z')
  })

  // R2-2: queued BEFORE worktree_done (T1), taken up AFTER it (T3). The enqueue must not count;
  // the take-up must, so a release at T2 is cancelled.
  it('a mid-turn prompt counts when it is taken up (`remove`), not when it was enqueued', () => {
    const t = track()
    t.apply(user('task A', '2026-09-27T10:00:00.000Z'))
    t.apply(q('enqueue', '2026-09-27T10:01:00.000Z', bus('[Operator · message from Operator] task B')))
    expect(t.lastPromptAt).toBe('2026-09-27T10:00:00.000Z')
    // worktree_done is called here, at 10:02.
    t.apply(q('remove', '2026-09-27T10:03:00.000Z', bus('[Operator · message from Operator] task B')))
    expect(t.lastPromptAt).toBe('2026-09-27T10:03:00.000Z')
    expect(t.lastPromptAt > '2026-09-27T10:02:00.000Z').toBe(true)
  })

  it('an idle delivery counts at its user record; the contentless dequeue adds nothing', () => {
    const t = track()
    t.apply(q('enqueue', '2026-09-27T10:00:00.000Z', bus('[Operator · message from Operator] build it')))
    t.apply(q('dequeue', '2026-09-27T10:00:00.030Z'))
    expect(t.lastPromptAt).toBe('')
    t.apply(user(`Another Claude session sent a message:\n${bus('[Operator · message from Operator] build it')}`, '2026-09-27T10:00:00.045Z'))
    expect(t.lastPromptAt).toBe('2026-09-27T10:00:00.045Z')
  })

  // R2-3: "merged, thanks" to a lane that just released must leave it released.
  it('replies and Operator notices are not work, on the pty, in the queue or over the bus', () => {
    const t = track()
    t.apply(user('real', '2026-09-27T10:00:00.000Z'))
    t.apply(user('[Operator · reply from Operator] merged, thanks', '2026-09-27T11:00:00.000Z'))
    t.apply(user('[Operator] Code is idle now.', '2026-09-27T11:01:00.000Z'))
    t.apply(user(`Another Claude session sent a message:\n${bus('[Operator · reply from Operator] merged')}`, '2026-09-27T11:02:00.000Z'))
    t.apply(q('remove', '2026-09-27T11:03:00.000Z', bus('[Operator · reply from Review] looks good')))
    expect(t.lastPromptAt).toBe('2026-09-27T10:00:00.000Z')
  })

  it('ignores injected turns, sidechains and tool results', () => {
    const t = track()
    t.apply(user('real', '2026-09-27T10:00:00.000Z'))
    t.apply(user('<task-notification>done</task-notification>', '2026-09-27T11:00:00.000Z'))
    t.apply(q('remove', '2026-09-27T11:00:00.000Z', '<task-notification>x</task-notification>'))
    t.apply(user('subagent prompt', '2026-09-27T11:00:00.000Z', { isSidechain: true }))
    t.apply({ type: 'user', timestamp: '2026-09-27T11:00:00.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } })
    expect(t.lastPromptAt).toBe('2026-09-27T10:00:00.000Z')
  })

  it('never moves backwards on an older record', () => {
    const t = track()
    t.apply(user('late', '2026-09-27T10:05:00.000Z'))
    t.apply(user('early', '2026-09-27T10:00:00.000Z'))
    expect(t.lastPromptAt).toBe('2026-09-27T10:05:00.000Z')
  })
})
