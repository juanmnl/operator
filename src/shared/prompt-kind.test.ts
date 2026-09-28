import { describe, it, expect } from 'vitest'
import { isWorkPrompt, replyPrefix, unwrapBusMessage } from './prompt-kind'

// Shapes taken from real transcripts (2026-09-25/27): a bus message arrives wrapped, in an
// `enqueue`/`remove` record's content and in the user record that follows a `dequeue`.
const bus = (inner: string) => `<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="p--operator" from-mode="prompting">\n${inner}\n</cross-session-message>`
const asUserRecord = (inner: string) => `Another Claude session sent a message:\n${bus(inner)}\n\nThis came from another Claude session — …`

describe('isWorkPrompt', () => {
  it('a person typing, and a dispatch on either path, are work', () => {
    expect(isWorkPrompt('fix the flaky test')).toBe(true)
    expect(isWorkPrompt(bus('[Operator · message from Operator] Build the retire path'))).toBe(true)
    expect(isWorkPrompt(asUserRecord('[Operator · message from Operator] Build it'))).toBe(true)
  })

  it('Operator notices and replies are not, on the pty and over the bus', () => {
    expect(isWorkPrompt('[Operator] Code is idle now.')).toBe(false)
    expect(isWorkPrompt(`${replyPrefix('Operator')}merged, thanks`)).toBe(false)
    expect(isWorkPrompt(bus(`${replyPrefix('Operator')}merged, thanks`))).toBe(false)
    expect(isWorkPrompt(asUserRecord(`${replyPrefix('Operator')}merged, thanks`))).toBe(false)
  })

  it('a bus message from outside Operator counts as work: unknown origin keeps the lane', () => {
    expect(isWorkPrompt(bus('please also update the docs'))).toBe(true)
  })

  it('unwrapBusMessage returns plain text unchanged', () => {
    expect(unwrapBusMessage('plain')).toBe('plain')
    expect(unwrapBusMessage(bus('inner'))).toBe('inner')
  })
})
