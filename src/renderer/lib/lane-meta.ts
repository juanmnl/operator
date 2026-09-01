// WHAT A LANE IS RUNNING ON — the two or three lines the sidebar's hover card adds under a lane's
// name, at both rail widths.
//
// The whole reason this is a module and not four lines inlined in a card: the honest answer has a
// PROVENANCE, and the provenance is the interesting part.
//
//   `session.runningModel` is an OBSERVATION — `transcript.rs` reads the model off the latest
//   assistant message, so it is what the lane actually answered with. It is absent until the
//   first assistant turn.
//   `session.model` is a MERGED value that prefers the launch config, so it says what we asked
//   for. A lane launched on the account default carries nothing here; a lane launched on `opus`
//   carries `opus` whether or not that is what came back.
//   `effortLevel` has NO observation at all, at any layer. We know what we launched with and
//   that is the end of it.
//
// So a row carries its source, always, and the two model readings are shown side by side when
// they disagree rather than one being silently picked. `RosterPanel`'s rule — "a lane reading
// 'Fable' while it launches Opus is worse than no readout" — is the same rule, one altitude down.
import { modelFamilyLabel } from './roster'
import { EFFORT_OPTIONS, migrateEffort } from './effort'

/** Where a value came from. `running` is the transcript; `at launch` is the config we sent. */
export type LaneMetaSource = 'running' | 'at launch'

export interface LaneMetaRow {
  /** Empty on a continuation row — the second model reading sits under the first one's key. */
  label: '' | 'model' | 'effort'
  value: string
  source: LaneMetaSource
}

export interface LaneMetaInput {
  model?: string
  runningModel?: string
}

/** The rows for one lane, in reading order. Empty when we know nothing — the caller renders no
 *  block at all rather than a card full of em dashes. */
export function laneMetaRows(session: LaneMetaInput, effortLevel?: string | null): LaneMetaRow[] {
  const rows: LaneMetaRow[] = []

  const running = session.runningModel ? modelFamilyLabel(session.runningModel) : null
  const configured = session.model ? modelFamilyLabel(session.model) : null

  if (running) {
    rows.push({ label: 'model', value: running, source: 'running' })
    // The configured reading only earns its own line when it NAMES A DIFFERENT FAMILY. Comparing
    // the labels, not the ids, is deliberate: `opus` and `claude-opus-5` are the same answer to
    // "what is this lane running", and printing both would turn every ordinary lane into a
    // two-line divergence report.
    if (configured && configured !== running) {
      rows.push({ label: '', value: configured, source: 'at launch' })
    }
  } else if (configured) {
    rows.push({ label: 'model', value: configured, source: 'at launch' })
  }

  // `migrateEffort` rather than a raw lookup: data written before the ladder was fixed still holds
  // `normal`, which reads as `medium`, and anything unrecognisable returns undefined so the row is
  // dropped instead of printing a value we cannot vouch for.
  const level = migrateEffort(effortLevel)
  if (level) {
    const label = EFFORT_OPTIONS.find((o) => o.id === level)?.label ?? level
    rows.push({ label: 'effort', value: label, source: 'at launch' })
  }

  return rows
}
