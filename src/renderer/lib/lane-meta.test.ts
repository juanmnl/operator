import { describe, it, expect } from 'vitest'
import { laneMetaRows } from './lane-meta'

// The rule under test is a HONESTY rule, not a formatting one: the hover may never print a
// configured model as if it had been observed. Every row carries its source, and the two readings
// appear side by side when they disagree.

describe('the model reading and where it came from', () => {
  it('reads the transcript when there is one, and says so', () => {
    expect(laneMetaRows({ model: 'opus', runningModel: 'claude-opus-5' }))
      .toEqual([{ label: 'model', value: 'Opus', source: 'running' }])
  })

  it('falls back to the launch config before the first assistant turn — labelled "at launch"', () => {
    expect(laneMetaRows({ model: 'sonnet' }))
      .toEqual([{ label: 'model', value: 'Sonnet', source: 'at launch' }])
  })

  // THE CASE THIS WHOLE READOUT IS FOR. A lane pinned to Opus that is actually answering as
  // Sonnet — an account default, or a `/model` typed into the terminal — must show both, running
  // first, rather than one being silently picked.
  it('shows BOTH when the running model is not the one we launched with', () => {
    expect(laneMetaRows({ model: 'opus', runningModel: 'claude-sonnet-5' })).toEqual([
      { label: 'model', value: 'Sonnet', source: 'running' },
      { label: '', value: 'Opus', source: 'at launch' },
    ])
  })

  // An alias and the full id it resolves to are the SAME answer. Printing both would turn every
  // ordinary lane into a two-line divergence report and make the real one unreadable.
  it('does not call an alias and its own full id a divergence', () => {
    expect(laneMetaRows({ model: 'opus', runningModel: 'claude-opus-4-20250514' }))
      .toEqual([{ label: 'model', value: 'Opus', source: 'running' }])
  })

  it('reports the transcript alone when the lane launched on the account default', () => {
    expect(laneMetaRows({ runningModel: 'claude-fable-5-1' }))
      .toEqual([{ label: 'model', value: 'Fable', source: 'running' }])
  })

  it('says nothing at all when nothing is known — the card renders no block, not an em dash', () => {
    expect(laneMetaRows({})).toEqual([])
  })
})

describe('effort, which has no observation anywhere', () => {
  it('is always sourced "at launch", never "running"', () => {
    const rows = laneMetaRows({ runningModel: 'claude-opus-5' }, 'medium')
    expect(rows).toContainEqual({ label: 'effort', value: 'Medium', source: 'at launch' })
    expect(rows.every((r) => r.label !== 'effort' || r.source === 'at launch')).toBe(true)
  })

  it('takes its label from the one ladder, `max` included', () => {
    expect(laneMetaRows({}, 'xhigh')).toEqual([{ label: 'effort', value: 'Extra high', source: 'at launch' }])
    expect(laneMetaRows({}, 'max')).toEqual([{ label: 'effort', value: 'Max', source: 'at launch' }])
  })

  // Data written before the ladder was fixed still holds `normal`, which is not a Claude Code
  // level. `migrateEffort`'s faithful reading of it is `medium`.
  it('renders a stored legacy `normal` as Medium', () => {
    expect(laneMetaRows({}, 'normal')).toEqual([{ label: 'effort', value: 'Medium', source: 'at launch' }])
  })

  it('drops a value it cannot vouch for rather than printing it', () => {
    expect(laneMetaRows({}, 'turbo')).toEqual([])
    expect(laneMetaRows({}, null)).toEqual([])
    expect(laneMetaRows({}, undefined)).toEqual([])
  })
})

describe('reading order', () => {
  it('model before effort, divergence stacked under the model key', () => {
    expect(laneMetaRows({ model: 'opus', runningModel: 'claude-haiku-4-5-20251001' }, 'low')
      .map((r) => `${r.label}|${r.value}|${r.source}`)).toEqual([
      'model|Haiku|running',
      '|Opus|at launch',
      'effort|Low|at launch',
    ])
  })
})
