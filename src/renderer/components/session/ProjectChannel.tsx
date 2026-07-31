import { useEffect, useMemo, useRef, useState } from 'react'
import type { Project, ProjectReply } from '../../../shared/types'
import { DragRegion } from '../DragRegion'
import { laneTextColor } from '../../lib/lane-color'
import { localTime } from '../../lib/local-time'
import {
  buildChannelFeed, groupByDay, channelInitials,
  type ChannelEntry, type ChannelSession, type ChipTone,
} from '../../lib/project-channel'
import {
  CHANNEL_MAX_CHARS, CHANNEL_COUNT_FROM, validateChannelMessage, type ChannelTarget,
} from '../../lib/channel-send'

/** What a send reports back, so the composer never has to guess what happened. */
export type SendResult =
  | { ok: true; delivered: number; skipped: string[] }
  | { ok: false; error?: string }

// The project CHANNEL — one time-ordered read of what the lanes have said to each other.
//
// It renders two stores that already exist and were never shown together: `Project.dispatches`
// (who asked whom to do what, and how it landed) and chat.db's OPERATOR-REPLY rows. The composer
// sends a HUMAN message; the header carries the kill switch for the lanes messaging each other.
//
// Vocabulary, and it matters: an author avatar is a CIRCLE. Squares are the PROJECT vocabulary
// (ProjectRail's tiles); circles are the lane/session vocabulary (StatusWave orbs, SessionItem).
// Blurring the two is how a project starts reading as an agent.

/** One measure for the header and the feed, so they share a left edge at every scrollbar width. */
const MEASURE = 720

// Chip ink. The accent-derived tones are MIXED toward --fg, not used raw: bare `var(--accent)`
// at this size measured 2.92:1 on Mission Control light and 2.44:1 on 1984 light — under the 3:1
// floor for supporting text. 55% keeps the hue and clears it on all six (same treatment, same
// ratio, as the sidebar's project name). `progress` and `muted` are dedicated tokens that were
// already tuned per palette, so they are left alone.
const ACCENT_INK = 'color-mix(in srgb, var(--accent) 55%, var(--fg))'
// Same treatment for --color-warning, and for the same measured reason: raw, at the 9px the
// agent↔agent switch uses, it came in at 2.44 / 2.42 / 1.49 on the three light palettes.
const WARN_INK = 'color-mix(in srgb, var(--color-warning) 55%, var(--fg))'
// `warn` used to resolve to ACCENT_INK — the SAME ink as `accent`. `chipForOutcome` has always
// toned the brakes (`hop-limit`, `pair-brake`, `paused`) and `undelivered` as warn, so the pure
// layer was right and this map flattened it: "posted · chain limit reached" rendered in exactly
// the colour of "posted · delivered", and a message the system deliberately refused to hand on
// read as one that arrived. Measured, not guessed — every chip in the feed came back
// `color(srgb 0.52 0.91 0.76)`.
//
// `--color-warning` rather than `--status-compacting`: the latter is already `progress` here, and
// two tones that mean different things must not share an ink for the same reason this was a bug.
const TONE: Record<ChipTone, string> = {
  accent: ACCENT_INK,
  progress: 'var(--status-compacting)',
  warn: 'var(--color-warning)',
  muted: 'var(--fg-muted)',
}

export function ProjectChannel({
  project, replies, sessions, onApproveDispatch, onRejectDispatch, onMarkRead, onSend,
  chatterPaused, onToggleChatter,
}: {
  project: Project
  /** Read from chat.db via projectReplies(); [] until a lane emits its first OPERATOR-REPLY. */
  replies: ProjectReply[]
  /** For attributing a reply: it carries a sessionId and no roleId. */
  sessions: ChannelSession[]
  /** The EXISTING approval handlers. A held dispatch is actioned through these and nothing else —
   *  a second approval path would be a second set of rules to keep in sync. */
  onApproveDispatch?: (projectId: string, id: string) => void
  onRejectDispatch?: (projectId: string, id: string) => void
  /** Called with the newest entry's timestamp once the feed has been seen. */
  onMarkRead?: (projectId: string, at: string) => void
  /** Send a human message. Absent = the composer stays inert (step 1's behaviour). */
  onSend?: (projectId: string, text: string, target: ChannelTarget) => SendResult
  /** The kill switch's state. `true` (the shipped default) = a lane's reply is posted here but
   *  NEVER typed into the addressee's session. Human→lane is a different path and unaffected. */
  chatterPaused?: boolean
  /** Flip it. Absent = the control is not rendered at all. */
  onToggleChatter?: () => void
}) {
  const feed = useMemo(
    () => buildChannelFeed(project.dispatches, replies, project.roster, sessions),
    [project.dispatches, replies, project.roster, sessions],
  )
  const days = useMemo(() => groupByDay(feed), [feed])

  // Reading the channel clears its unread count. Keyed on the newest timestamp so re-rendering
  // with the same feed doesn't write repeatedly.
  const newest = feed.length ? feed[feed.length - 1].at : null
  useEffect(() => { if (newest) onMarkRead?.(project.id, newest) }, [project.id, newest, onMarkRead])

  // Land at the bottom: a channel's newest entry is the one you came to read.
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [project.id])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0, background: 'var(--bg-terminal)', fontFamily: 'var(--font-body)' }}>
      {/* Scroller FULL WIDTH with the measure on inner children, and the header sticky INSIDE it
          — the containing-block rule from dev/briefs/fix-scrollbar-layout-shift.md. `scroll` not
          `auto` so the classic scrollbar's 6px is reserved in both states and the centred measure
          box can't re-centre 3px when the feed grows past the fold. */}
      <div className="channel-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'scroll' }}>
        <DragRegion style={{
          position: 'sticky', top: 0, zIndex: 2, background: 'var(--bg-terminal)',
          borderBottom: '1px solid var(--border)',
        }}>
          <div style={{
            maxWidth: MEASURE, margin: '0 auto', boxSizing: 'border-box',
            display: 'flex', alignItems: 'baseline', gap: 8, height: 44, padding: '0 16px',
          }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--fg-muted)' }}>#</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>channel</span>
            {/* Shrinks and ellipsizes so the switch beside it can never be pushed out of the
                header (with no wrap, an unshrinkable name would simply overflow it away). */}
            <span style={{
              minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--fg-muted)',
            }}>
              {project.name}
            </span>
            {/* The kill switch — and delivery now defaults to LIVE (flipped 2026-07-30). It shipped
                paused because two agents that can each answer the other ping-pong indefinitely;
                that risk is now carried by the brakes in lib/agent-delivery, and default-off had
                its own cost — replies posted to the channel and reached nobody, so the feed filled
                with POSTED rows while the addressee sat idle. Label states what IS, not what the
                click does — a control that reads "Pause" while already paused is how you turn
                chatter on by accident while trying to stop it. */}
            {onToggleChatter && (
              <button
                onClick={onToggleChatter}
                data-chatter-toggle
                aria-pressed={!chatterPaused}
                title={chatterPaused
                  ? 'Agents post to the channel but nothing reaches their sessions. Click to let them deliver.'
                  : 'Agents are delivering messages to each other. Click to halt it.'}
                style={{
                  marginLeft: 'auto', flexShrink: 0, cursor: 'pointer', outline: 'none',
                  fontFamily: 'var(--font-mono)', fontSize: 9, textTransform: 'uppercase',
                  letterSpacing: '0.1em', padding: '3px 8px', borderRadius: 'var(--radius-sm)',
                  // The border stays STATIC and the state rides on the ink: a colour-CHANGING
                  // border on a border-radius element re-rasterizes in WKWebView, and this one
                  // changes on a click.
                  background: chatterPaused ? 'transparent' : 'var(--overlay-medium)',
                  border: '1px solid var(--border)',
                  color: chatterPaused ? 'var(--fg-muted)' : WARN_INK,
                }}
              >
                {chatterPaused ? 'Agent↔agent paused' : 'Agent↔agent live'}
              </button>
            )}
          </div>
        </DragRegion>

        <div style={{ maxWidth: MEASURE, margin: '0 auto', padding: '14px 16px 24px', boxSizing: 'border-box' }}>
          {feed.length === 0 ? (
            <p data-channel-empty style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--fg-muted)', margin: 0 }}>
              Nothing here yet. This is where dispatches between your agents — and any
              <code style={{ margin: '0 4px', fontFamily: 'var(--font-mono)', fontSize: 11 }}>OPERATOR-REPLY</code>
              a lane posts — appear together, oldest first.
            </p>
          ) : days.map((group) => (
            <div key={group.day}>
              {/* Day separator: a hairline with the date sitting on it. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '18px 0 12px' }}>
                <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
                <span data-channel-day style={{
                  flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 9,
                  textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--fg-muted)',
                }}>
                  {group.day}
                </span>
                <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
              </div>
              {group.entries.map((e) => (
                <ChannelRow
                  key={e.id}
                  entry={e}
                  projectId={project.id}
                  onApprove={onApproveDispatch}
                  onReject={onRejectDispatch}
                />
              ))}
            </div>
          ))}
          <div ref={endRef} />
        </div>
      </div>

      <Composer project={project} onSend={onSend} />
    </div>
  )
}

function ChannelRow({ entry, projectId, onApprove, onReject }: {
  entry: ChannelEntry
  projectId: string
  onApprove?: (projectId: string, id: string) => void
  onReject?: (projectId: string, id: string) => void
}) {
  const accent = entry.authorRole?.accent
  // The raw DispatchRecord id, recovered from the prefixed entry id, for the approval handlers.
  const dispatchId = entry.kind === 'dispatch' ? entry.id.slice('dispatch:'.length) : null
  const held = !!entry.chip.actionable && !!dispatchId
  return (
    <div data-channel-row={entry.id} style={{ display: 'flex', gap: 10, padding: '7px 0', alignItems: 'flex-start' }}>
      {/* CIRCLE — lane vocabulary. Accent tint + a STATIC hairline (a colour-changing border on a
          radiused element re-rasterizes in WKWebView), initials through laneTextColor so they
          clear 4.5:1 on the three light palettes where a raw accent collapses to ~1.4. A human or
          unresolved author gets a neutral fill instead of a borrowed lane colour. */}
      <span
        data-channel-avatar
        style={{
          flexShrink: 0, width: 26, height: 26, borderRadius: '50%',
          display: 'grid', placeItems: 'center',
          background: accent ? `color-mix(in srgb, ${accent} 16%, transparent)` : 'var(--overlay-medium)',
          border: `1px solid ${accent ? `color-mix(in srgb, ${accent} 38%, transparent)` : 'var(--border)'}`,
          color: accent ? laneTextColor(accent) : 'var(--fg-muted)',
          fontSize: 9.5, fontWeight: 600, letterSpacing: '0.02em', lineHeight: 1,
        }}
      >
        {channelInitials(entry.authorLabel)}
      </span>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap' }}>
          <span data-channel-author style={{
            fontSize: 11.5, fontWeight: 600,
            color: accent ? laneTextColor(accent) : 'var(--fg)',
          }}>
            {entry.authorLabel}
          </span>
          {entry.targetLabel && (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--fg-muted)' }}>
              → {entry.targetLabel}
            </span>
          )}
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--fg-muted)', fontVariantNumeric: 'tabular-nums' }}>
            {localTime(entry.at)}
          </span>
          <span data-channel-chip style={{
            fontFamily: 'var(--font-mono)', fontSize: 8.5, textTransform: 'uppercase',
            letterSpacing: '0.06em', color: TONE[entry.chip.tone],
          }}>
            {entry.chip.label}
          </span>
        </div>
        {/* Prose, in the body face: this is what an agent said, not a protocol line. */}
        <div data-channel-text style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--fg)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: 2 }}>
          {entry.text}
        </div>
        {held && (
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button
              data-channel-approve={dispatchId}
              onClick={() => onApprove?.(projectId, dispatchId!)}
              style={{
                padding: '2px 9px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
                background: 'var(--btn-bg)', color: 'var(--fg)', cursor: 'pointer', outline: 'none',
                fontFamily: 'var(--font-body)', fontSize: 11,
              }}
            >Approve &amp; send</button>
            <button
              data-channel-reject={dispatchId}
              onClick={() => onReject?.(projectId, dispatchId!)}
              style={{
                padding: '2px 9px', borderRadius: 'var(--radius-sm)', border: 'none',
                background: 'transparent', color: 'var(--fg-muted)', cursor: 'pointer', outline: 'none',
                fontFamily: 'var(--font-body)', fontSize: 11,
              }}
            >Decline</button>
          </div>
        )}
      </div>
    </div>
  )
}

/** The composer — LIVE for human → one lane, and human → everyone.
 *
 *  Lane → lane is still not a thing here: this sends only what the person typed. Two rules it
 *  enforces rather than trusts:
 *
 *  • THE CAP IS CHECKED TWICE. Here, and again in the handler before submitQueue. A paste plus an
 *    immediate ⌘↵ can outrun a React state update, so the composer's own check cannot be the only
 *    one. Over-cap NEVER truncates — a silently shortened message is worse than a refused one.
 *  • THE STATE SHOWN IS THE REAL ONE. Nothing renders optimistically as delivered: the message
 *    appears from the store with the outcome the handler actually recorded, so a queued message
 *    looks queued from the first frame.
 */
function Composer({ project, onSend }: {
  project: Project
  onSend?: (projectId: string, text: string, target: ChannelTarget) => SendResult
}) {
  const roster = project.roster ?? []
  const [target, setTarget] = useState<ChannelTarget>('everyone')
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const check = validateChannelMessage(draft)
  const live = !!onSend
  const overCap = check.over > 0
  const showCount = draft.trim().length >= CHANNEL_COUNT_FROM

  const send = () => {
    if (!onSend) return
    const res = onSend(project.id, draft, target)
    if (!res.ok) { setNotice(res.error ?? 'Could not send.'); return }
    setDraft('')
    // Report what actually happened, including who did NOT get it — a message silently not
    // arriving is the failure this whole feed exists to make visible.
    setNotice(res.skipped.length
      ? `Sent to ${res.delivered} lane${res.delivered === 1 ? '' : 's'}. Queued for ${res.skipped.join(', ')} — ${res.skipped.length === 1 ? 'it' : 'they'} will read it when next running.`
      : `Sent to ${res.delivered} lane${res.delivered === 1 ? '' : 's'}.`)
  }

  return (
    <div style={{ flexShrink: 0, borderTop: '1px solid var(--border)', background: 'var(--bg-terminal)' }}>
      <div style={{ maxWidth: MEASURE, margin: '0 auto', padding: '10px 16px 12px', boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 6, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--fg-muted)' }}>
            to
          </span>
          {([['everyone', 'everyone'], ...roster.map((r) => [r.id, r.name] as const)] as [string, string][]).map(([id, name]) => {
            const on = target === id
            return (
              <button
                key={id}
                data-channel-pill={name}
                aria-pressed={on}
                disabled={!live}
                onClick={() => { setTarget(id); setNotice(null) }}
                style={{
                  padding: '1px 7px', borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border)',
                  // Selection is a faint surface tint plus normal ink — never an accent fill.
                  background: on ? 'var(--overlay-medium)' : 'transparent',
                  color: on ? 'var(--fg)' : 'var(--fg-muted)',
                  cursor: live ? 'pointer' : 'not-allowed', outline: 'none',
                  fontFamily: 'var(--font-mono)', fontSize: 9,
                }}
              >
                {name}
              </button>
            )
          })}
          {showCount && (
            <span data-channel-count style={{
              marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 9,
              fontVariantNumeric: 'tabular-nums',
              color: overCap ? 'var(--color-error, #f85149)' : 'var(--fg-muted)',
            }}>
              {CHANNEL_MAX_CHARS - draft.trim().length}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
          <textarea
            data-channel-composer
            disabled={!live}
            rows={2}
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setNotice(null) }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send() }
            }}
            placeholder={live
              ? `Message ${target === 'everyone' ? 'every live lane' : (roster.find((r) => r.id === target)?.name ?? target)}…  ⌘↵ to send`
              : 'Sending arrives in the next step — this channel is read-only for now.'}
            style={{
              flex: 1, minWidth: 0, boxSizing: 'border-box', resize: 'none',
              padding: '7px 9px', borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border)', background: 'transparent',
              color: live ? 'var(--fg)' : 'var(--fg-muted)',
              fontFamily: 'var(--font-body)', fontSize: 12, lineHeight: 1.5,
              cursor: live ? 'text' : 'not-allowed',
            }}
          />
          <button
            data-channel-send
            disabled={!live || !check.ok}
            onClick={send}
            title={overCap ? check.error : 'Send to the selected target (⌘↵)'}
            style={{
              flexShrink: 0, padding: '6px 12px', borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border)',
              background: live && check.ok ? 'var(--btn-bg)' : 'transparent',
              color: live && check.ok ? 'var(--fg)' : 'var(--fg-muted)',
              cursor: live && check.ok ? 'pointer' : 'not-allowed', outline: 'none',
              fontFamily: 'var(--font-mono)', fontSize: 10,
            }}
          >Send ⌘↵</button>
        </div>
        <p data-channel-composer-note style={{ margin: '6px 0 0', fontSize: 10.5, lineHeight: 1.5, color: 'var(--fg-muted)' }}>
          {notice ?? (overCap
            ? check.error
            : 'Delivery takes about a second at best, and a busy lane reads this when its current task ends. An idle lane is never started to receive a message — it gets it next time it runs.')}
        </p>
      </div>
    </div>
  )
}
