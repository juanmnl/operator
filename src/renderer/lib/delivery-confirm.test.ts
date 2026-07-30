import { describe, it, expect } from 'vitest'
import { matchSubmission, normalizeTurn, userTurnsSince, TURN_TEXT_CAP, SINCE_SLACK_MS } from './delivery-confirm'

const at = (ms: number) => new Date(ms).toISOString()

describe('normalizeTurn', () => {
  it('collapses the differences a round trip through a composer creates', () => {
    expect(normalizeTurn('  do   the\n thing \n')).toBe('do the thing')
    expect(normalizeTurn('a\tb')).toBe('a b')
  })

  it('does NOT normalise away content — case and punctuation are the message', () => {
    expect(normalizeTurn('Do It.')).toBe('Do It.')
    expect(normalizeTurn('Do it')).not.toBe(normalizeTurn('do it'))
  })
})

describe('matchSubmission', () => {
  it('confirms a turn carrying what we sent, whitespace notwithstanding', () => {
    expect(matchSubmission('do the thing', ['do the thing'])).toBe('delivered')
    expect(matchSubmission('do the thing', ['  do   the\nthing '])).toBe('delivered')
  })

  it('finds it among other turns, in any position', () => {
    expect(matchSubmission('B', ['A', 'B', 'C'])).toBe('delivered')
  })

  it('reports nothing resembling it as none', () => {
    expect(matchSubmission('do the thing', ['something else'])).toBe('none')
    expect(matchSubmission('do the thing', [])).toBe('none')
    expect(matchSubmission('', ['do the thing'])).toBe('none')
  })

  it('confirms a LONG message the tailer truncated', () => {
    // transcript.rs caps a recorded prompt and appends an ellipsis, so a long dispatch can
    // never come back verbatim — demanding equality would call every one of them a failure.
    const sent = 'T'.repeat(TURN_TEXT_CAP + 500)
    const recorded = 'T'.repeat(TURN_TEXT_CAP) + '…'
    expect(matchSubmission(sent, [recorded])).toBe('delivered')
  })

  it('CATCHES THE SPLIT: a turn holding only the front of what we sent', () => {
    // The reported P0 — one dispatch arriving as a truncated turn with the tail stranded.
    const sent = 'Please rework the dispatch router and then report back with the findings'
    expect(matchSubmission(sent, ['Please rework the dispatch router'])).toBe('split')
  })

  it('does not call a short unrelated turn a split', () => {
    // "yes" opens plenty of sentences. Calling that a broken delivery would raise a false alarm
    // in the more alarming direction.
    expect(matchSubmission('yes, and then rebuild the index', ['yes'])).toBe('none')
  })

  it('does not mistake a long ordinary prompt ending in an ellipsis for a truncation', () => {
    // The ellipsis is the tailer's marker, but only a message past the cap can have been
    // truncated — without the length test a genuinely split message would pass as delivered.
    const sent = 'wait for it, and then keep going until the whole queue is drained'
    expect(matchSubmission(sent, ['wait for it…'])).toBe('none')
  })

  it('prefers a real delivery over a prefix — a re-dispatch produces both', () => {
    const sent = 'Please rework the dispatch router and report back'
    expect(matchSubmission(sent, ['Please rework the dispatch router', sent])).toBe('delivered')
    expect(matchSubmission(sent, [sent, 'Please rework the dispatch router'])).toBe('delivered')
  })

  it('is not fooled by a turn LONGER than what we sent', () => {
    expect(matchSubmission('do the thing', ['do the thing and then some more'])).toBe('none')
  })
})

describe('userTurnsSince', () => {
  const messages = [
    { kind: 'user', text: 'old prompt', timestamp: at(1_000) },
    { kind: 'text', text: 'an assistant answer', timestamp: at(5_000) },
    { kind: 'user', text: 'new prompt', timestamp: at(10_000) },
  ]

  it('keeps only human prompts, dropping assistant prose', () => {
    expect(userTurnsSince(messages, 0)).toEqual(['old prompt', 'new prompt'])
  })

  it('windows to the submission, so a REPEAT does not confirm itself', () => {
    // The case this exists for: dispatching the same sentence twice. Matching the whole tail
    // would confirm the second send instantly, using the first send's turn as proof.
    expect(userTurnsSince(messages, 8_000)).toEqual(['new prompt'])
    expect(userTurnsSince(messages, 20_000)).toEqual([])
  })

  it('allows slack for ordinary clock jitter between the write and the transcript', () => {
    // A turn timestamped a hair BEFORE our write time is still ours.
    expect(userTurnsSince(messages, 10_000 + SINCE_SLACK_MS)).toEqual(['new prompt'])
    expect(userTurnsSince(messages, 10_000 + SINCE_SLACK_MS + 1)).toEqual([])
  })

  it('keeps an entry whose timestamp is missing or unparseable', () => {
    // Dropping it could only ever lose our own delivery, and the two failures are not
    // symmetric: a missed confirmation cries wolf, a stale one hides a real loss.
    const odd = [{ kind: 'user', text: 'no stamp' }, { kind: 'user', text: 'bad', timestamp: 'nope' }]
    expect(userTurnsSince(odd, 999_999)).toEqual(['no stamp', 'bad'])
  })

  it('handles a session with no messages at all', () => {
    expect(userTurnsSince(undefined, 0)).toEqual([])
  })
})
