import { Fragment } from 'react'
import { laneMetaRows, type LaneMetaInput } from '../../lib/lane-meta'

// The model/effort block inside a lane's hover card. ONE component for both rail widths — the
// collapsed orb's card and the expanded row's card are the same widget at two anchor points, and
// a second copy of this grid is how the two would start disagreeing about what a lane is running.
//
// Three columns, and the third one is the point: every value states its own source, so "running"
// (read off the transcript) never gets mistaken for "at launch" (what we sent). When the two
// model readings disagree they stack under one key, running first, because that is the reading
// that is true right now.
//
// House style: semantic vars only, and the source column takes `--fg-muted` FLAT — the token is
// already the recede, and stacking opacity on it lands at 1.8–2.9:1.

export function LaneMeta({ session, effortLevel }: {
  session: LaneMetaInput
  effortLevel?: string | null
}) {
  const rows = laneMetaRows(session, effortLevel)
  if (!rows.length) return null
  return (
    <div
      data-lane-meta
      style={{
        display: 'grid',
        // The VALUE column absorbs the slack (and, with `minmax(0, …)`, is allowed to shrink):
        // `modelFamilyLabel` returns the raw id for anything it does not recognise — a Bedrock
        // `us.anthropic.claude-…-v1:0`, say — and three `auto` columns would have pushed that
        // straight out past the card's 260px edge, `nowrap` and all.
        gridTemplateColumns: 'auto minmax(0, 1fr) auto',
        columnGap: 10,
        rowGap: 3,
        alignItems: 'baseline',
        whiteSpace: 'nowrap',
      }}
    >
      {rows.map((r, i) => (
        <Fragment key={`${r.label}-${r.value}-${i}`}>
          <span style={{
            fontSize: 9, color: 'var(--fg-muted)',
            textTransform: 'uppercase', letterSpacing: '0.1em',
          }}>{r.label}</span>
          <span style={{
            fontSize: 11, color: 'var(--fg)',
            overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{r.value}</span>
          {/* Right-aligned so the sources form their own column: two model rows put "running"
              directly above "at launch", which is what makes a divergence legible at a glance
              instead of something you have to read twice. */}
          <span style={{
            fontSize: 9, color: 'var(--fg-muted)',
            textTransform: 'uppercase', letterSpacing: '0.1em',
            justifySelf: 'end',
          }}>{r.source}</span>
        </Fragment>
      ))}
    </div>
  )
}

/** The rule between the task text and this block. Its own export so both cards draw the same one
 *  — and so neither draws it when there is nothing on one side of it. */
export function LaneMetaSeam() {
  return (
    <div style={{
      height: 1, margin: '7px 0',
      background: 'color-mix(in srgb, var(--fg) 12%, transparent)',
    }} />
  )
}
