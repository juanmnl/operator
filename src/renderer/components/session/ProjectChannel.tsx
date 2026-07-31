import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Project, ProjectReply } from '../../../shared/types'
import { DragRegion } from '../DragRegion'
import { laneTextColor } from '../../lib/lane-color'
import { localTime } from '../../lib/local-time'
import { parseInline } from '../../lib/canvas-md'
import {
  buildChannelFeed, groupByDay, channelInitials, isContinuation, isActionableChip,
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

/** THE SHARED LEFT EDGE. Header, every feed row and the composer all start here, so the three
 *  parts of the pane read as one column rather than three things each centred on their own.
 *  This replaced a fixed 720px centred measure: in a 2000px window that parked the whole
 *  conversation in the middle of the field with ~1200px of dead page beside it. */
const INSET = 16

/** …but NOT for prose. The shell wants the pane's full width — the header, the composer and the
 *  row all use it. The BODY does not: a full-bleed row at 1800px with unconstrained text is ~300
 *  characters a line.
 *
 *  A CEILING, not a fixed width. The body grows with the pane and stops at 900 (`max-width` plus
 *  the row's flex is the clamp — there is no lower bound to enforce beyond what the pane gives).
 *
 *  This was 470 (~79 chars) and that was too tight. The 60–80 guideline it came from is calibrated
 *  for SUSTAINED prose — long documents read for minutes, where the eye hunts for each next line's
 *  start. This feed is scanned in bursts: entries are a few lines, folded at four, and the eye
 *  returns to a known left edge constantly. Different reading task, different measure.
 *  The content argues for it too. These bodies are path-heavy —
 *  `dev/briefs/channel-timestamps-utc-RESULT.md` is 43 characters on its own — and `parseInline`
 *  renders those spans as atomic chips, so breaking one mid-token is worse than a long line. At
 *  470 they wrapped constantly.
 *  Sized by MEASURING, which this file has now caught twice: 520px "looked right" arithmetically
 *  and came out at 87 chars. */
const PROSE = 900

/** The avatar column: the circle and the gap before the text. Named because three things depend
 *  on it — the row, the continuation gutter that keeps a run's bodies on one edge, and ROW_MAX. */
const AVATAR = 26
const AVATAR_GAP = 10

/** How far row CONTENT runs before it stops. The row itself is full-bleed — its hover background
 *  and hit area go edge to edge, which is the point of the change — but the things inside it are
 *  bounded, because "full width" and "unbounded" are not the same thing.
 *  DERIVED, not chosen: avatar column + prose + the action rail, so the content edge is the place
 *  the content actually ends. Two things went wrong before this landed, both worth keeping:
 *   • a round 880 left the hover action floating ~360px past the last word, orphaned mid-row —
 *     the same "content adrift in a wide field" complaint this brief exists to fix, just moved;
 *   • omitting the action from the sum let it EAT the prose instead (470 -> 414px, 79 -> 69
 *     chars), because it is a flex sibling of the body column. If it is in the row, it is in the
 *     arithmetic. */
const ACTION_W = 54
// TWO gaps, not one: the row is a flex container with `gap: AVATAR_GAP`, so it separates
// avatar|body AND body|action. Adding a margin on the button as well double-counted the second
// one and quietly cost the prose 10px (79 -> 77 chars).
const ROW_MAX = AVATAR + AVATAR_GAP + PROSE + AVATAR_GAP + ACTION_W

/** Below this the action rail stops earning its 64px and the prose takes it back. Measured, not
 *  guessed: at a 326px pane the body was down to 33 characters a line with the rail present. */
const NARROW_AT = 520

/** The composer gets its own, wider cap. It shares the LEFT edge with everything else — that is
 *  what the pane needs — but it is a writing surface, not a reading one: matching it to a 79-char
 *  reading measure would make composing a paragraph needlessly cramped. Right edges may differ by
 *  role; the left edge may not. */
const COMPOSER_MAX = 720



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
  // Was ACCENT_INK — byte-identical to `accent`, so `held · needs your approval` and the two
  // brakes painted the exact same colour as `delivered`. A dispatch waiting on the user looked
  // like one that had already landed, which is the one confusion this chip exists to prevent.
  // WARN_INK was already defined and measured; it just wasn't wired to the tone that needs it.
  // NOT raw `var(--color-warning)`: that is what the 55%-toward-fg mix above exists to fix, and
  // it measured 2.44 / 2.42 / 1.49 on the three light palettes — under the 3:1 floor.
  warn: WARN_INK,
  muted: 'var(--fg-muted)',
}

/** How many lines of a body show before it folds.
 *
 *  Sized against the real store, not by eye. At the PROSE measure a line is ~80 characters, and
 *  `~/.operator/projects.json` has a median dispatch task of 520 characters and a p90 of 1165 —
 *  roughly 6.5 and 15 lines. A 6-line clamp would leave the MEDIAN entry all but unfolded and
 *  catch only the tail, which is most of the wall still standing. Four folds the median, keeps
 *  the ask ("Read dev/briefs/X.md and do it…") which is the part a skim actually reads, and puts
 *  the rest one click away. */
const CLAMP_LINES = 4

/** Past this, the body renders as plain text with no inline pass. Bodies are capped elsewhere,
 *  so this is a backstop rather than a live limit — but the reading panels' freeze
 *  (project_chat_markdown_freeze) came from re-parsing markup on every update, and this surface
 *  re-renders on every `session:update`. Cheap parser, memoised, and still capped. */
const INLINE_CAP = 8192

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

  // What the pause has actually cost. Counted off the chips the data layer already wrote, so this
  // can never claim a loss that the store doesn't record.
  const heldByPause = useMemo(
    () => feed.filter((e) => e.chip.label.includes('agent↔agent paused')).length,
    [feed],
  )

  // Reading the channel clears its unread count. Keyed on the newest timestamp so re-rendering
  // with the same feed doesn't write repeatedly.
  const newest = feed.length ? feed[feed.length - 1].at : null
  useEffect(() => { if (newest) onMarkRead?.(project.id, newest) }, [project.id, newest, onMarkRead])

  // How tall the pinned chrome currently is, so the day divider can stick directly under it.
  // Measured rather than hardcoded: the paused notice appears and disappears with the feed's
  // contents, and a fixed offset would leave the divider either overlapped or floating.
  const chromeRef = useRef<HTMLDivElement>(null)
  const [chromeH, setChromeH] = useState(45)
  useLayoutEffect(() => {
    const el = chromeRef.current
    if (!el) return
    const measure = () => setChromeH(Math.round(el.getBoundingClientRect().height))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // SCROLL ANCHORING ACROSS A REFLOW.
  //
  // The pane is live and resizable — the Plan/Diff panel takes width from it — and now that rows
  // are full-bleed, a width change re-wraps every body and changes the height of the whole feed
  // above you. Measured before this existed: narrowing 1400 -> 900 moved the row under the
  // reader's eye by 16px.
  //
  // The anchor is recorded on SCROLL, not on resize, because by the time a ResizeObserver fires
  // the new layout is already in place and the old position is gone. So: remember the topmost
  // visible row and how far it sat below the fold; after a width change, put it back there.
  const scrollRef = useRef<HTMLDivElement>(null)
  const anchorRef = useRef<{ id: string; offset: number } | null>(null)
  const widthRef = useRef(0)
  const [narrow, setNarrow] = useState(false)

  const rememberAnchor = useCallback(() => {
    const sc = scrollRef.current
    if (!sc) return
    const top = sc.getBoundingClientRect().top
    for (const el of sc.querySelectorAll<HTMLElement>('[data-channel-row]')) {
      const r = el.getBoundingClientRect()
      if (r.bottom > top) {
        anchorRef.current = { id: el.dataset.channelRow ?? '', offset: r.top - top }
        return
      }
    }
    anchorRef.current = null
  }, [])

  useLayoutEffect(() => {
    const sc = scrollRef.current
    if (!sc || typeof ResizeObserver === 'undefined') return
    widthRef.current = sc.clientWidth
    setNarrow(sc.clientWidth < NARROW_AT)
    const ro = new ResizeObserver(() => {
      const w = sc.clientWidth
      setNarrow(w < NARROW_AT)
      if (w === widthRef.current) return // height-only change: nothing re-wrapped
      widthRef.current = w
      const a = anchorRef.current
      if (!a) return
      const el = sc.querySelector<HTMLElement>(`[data-channel-row="${CSS.escape(a.id)}"]`)
      if (!el) return
      const delta = (el.getBoundingClientRect().top - sc.getBoundingClientRect().top) - a.offset
      if (delta) sc.scrollTop += delta
    })
    ro.observe(sc)
    return () => ro.disconnect()
  }, [])

  // Land at the bottom: a channel's newest entry is the one you came to read.
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [project.id])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0, background: 'var(--bg-terminal)', fontFamily: 'var(--font-body)' }}>
      {/* Scroller FULL WIDTH with the measure on inner children, and the header sticky INSIDE it
          — the containing-block rule from dev/briefs/fix-scrollbar-layout-shift.md. `scroll` not
          `auto` so the classic scrollbar's 6px is reserved in both states and the centred measure
          box can't re-centre 3px when the feed grows past the fold. */}
      <div
        ref={scrollRef}
        onScroll={rememberAnchor}
        className="channel-scroll"
        style={{ flex: 1, minHeight: 0, overflowY: 'scroll' }}
      >
        {/* ONE sticky block for all the pinned chrome — the header and, when it applies, the
            paused notice. They used to be two independent stickies at `top: 0` and `top: 45`,
            which works right up until something else needs to pin BELOW them: a hardcoded offset
            can't know whether the notice is showing. Measured instead (see `chromeH`), so the day
            divider can sit under whatever chrome is actually there. */}
        <div ref={chromeRef} style={{
          position: 'sticky', top: 0, zIndex: 3, background: 'var(--bg-terminal)',
        }}>
        <DragRegion style={{
          background: 'var(--bg-terminal)',
          borderBottom: '1px solid var(--border)',
        }}>
          {/* Full-bleed. The kill switch rides the far right because it is PANE chrome — a
              titlebar control — not row furniture, so it belongs to the pane's edge. */}
          <div style={{
            boxSizing: 'border-box',
            display: 'flex', alignItems: 'baseline', gap: 8, height: 44, padding: `0 ${INSET}px`,
          }}>
            <span data-channel-hash style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--fg-muted)' }}>#</span>
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

        {/* THE PAUSE, WHERE ITS CONSEQUENCE IS. The header pill states the setting; it does not
            say that anything was lost by it, and it is the quietest thing in the header precisely
            when it matters most. This notice is different: it appears only once the pause has
            actually cost something — at least one message posted to the room that reached nobody
            — and it says how many, in the feed, next to them. No standing nag: the switch ships
            paused, so a banner on every launch would be furniture within a day. */}
        {/* Inside the sticky chrome block, so it is pinned with the header rather than beside
            it. The feed opens scrolled to its newest entry, so a notice parked at the top of the
            document is one nobody ever sees. */}
        {chatterPaused && heldByPause > 0 && (
          <div style={{
            background: 'var(--bg-terminal)',
            maxWidth: COMPOSER_MAX + INSET * 2, padding: `10px ${INSET}px`, boxSizing: 'border-box',
          }}>
            {/* STACKS when the pane is narrow. As a wrapping baseline row it could not fit its
                three parts — headline, explanation, and an unshrinkable button — into a ~290px
                pane, and pushed the scroller's content 30px past its own edge. `flexWrap` alone
                does not save you when one child has a hard minimum. */}
            <div data-channel-paused-banner style={{
              display: 'flex',
              flexDirection: narrow ? 'column' : 'row',
              alignItems: narrow ? 'flex-start' : 'baseline',
              gap: 8, flexWrap: 'wrap',
              padding: '7px 10px', borderRadius: 'var(--radius-sm)',
              // Transparent tint + a static hairline, per house style — never a solid fill, and
              // never a colour-changing border on a radiused element.
              background: 'color-mix(in srgb, var(--color-warning) 9%, transparent)',
              border: '1px solid var(--border)',
            }}>
              {/* Plain --fg, not WARN_INK. This is the one full sentence in the banner, so it
                  answers to the 4.5:1 body floor rather than the 3:1 one the chips use — and
                  WARN_INK measured 4.27:1 on 1984 light, just under it. The amber tint behind it
                  and the amber chips it refers to already carry the tone; the sentence only has
                  to be read. */}
              <span style={{ minWidth: 0, fontSize: 11.5, fontWeight: 600, color: 'var(--fg)' }}>
                {heldByPause} message{heldByPause === 1 ? '' : 's'} posted here reached no one.
              </span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: 'var(--fg-muted)' }}>
                Agent→agent delivery is paused, so lanes can post but nothing is typed into another
                lane's session. Your own messages are unaffected.
              </span>
              {onToggleChatter && (
                <button
                  data-channel-paused-resume
                  onClick={onToggleChatter}
                  style={{
                    flexShrink: 0, padding: '2px 9px', borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border)', background: 'var(--btn-bg)',
                    color: 'var(--fg)', cursor: 'pointer', outline: 'none',
                    fontFamily: 'var(--font-body)', fontSize: 11,
                  }}
                >Let them deliver</button>
              )}
            </div>
          </div>
        )}
        </div>

        {/* No horizontal padding here: the ROWS carry it, which is what lets their hover
            background and hit area reach the pane's edges while their content stays inset. */}
        <div style={{ padding: '14px 0 24px', boxSizing: 'border-box' }}>
          {feed.length === 0 ? (
            <p data-channel-empty style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--fg-muted)', margin: 0, padding: `0 ${INSET}px`, maxWidth: PROSE + INSET * 2 }}>
              Nothing here yet. This is where dispatches between your agents — and any
              <code style={{ margin: '0 4px', fontFamily: 'var(--font-mono)', fontSize: 11 }}>OPERATOR-REPLY</code>
              a lane posts — appear together, oldest first.
            </p>
          ) : days.map((group) => (
            <div key={group.day}>
              {/* Day separator: a hairline with the date sitting on it — and STICKY, because a
                  static one only tells you the date while it happens to be on screen. Scrolled
                  into the middle of a long feed every timestamp read `04:05` with nothing saying
                  which day that was. It pins under whatever chrome is showing (`chromeH`), and
                  carries the field colour so rows pass under it rather than through it. */}
              {/* LEFT-ANCHORED, not centred between two rules. A date floating at the middle of a
                  2000px pane is the same defect as the old centred column, just one line tall —
                  and the whole point of this layout is that everything starts at one edge. The
                  rule now trails off to the right instead of framing it. */}
              <div style={{
                position: 'sticky', top: chromeH, zIndex: 1,
                background: 'var(--bg-terminal)',
                display: 'flex', alignItems: 'center', gap: 10, margin: '18px 0 12px',
                padding: `6px ${INSET}px`,
              }}>
                <span data-channel-day style={{
                  flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 9,
                  textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--fg-muted)',
                }}>
                  {group.day}
                </span>
                <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
              </div>
              {group.entries.map((e, i) => (
                <ChannelRow
                  key={e.id}
                  entry={e}
                  projectId={project.id}
                  // Day buckets never merge across the separator: `group.entries` is one day, so
                  // the first row of a day always prints its author.
                  continuation={isContinuation(group.entries[i - 1], e)}
                  narrow={narrow}
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

/** Inline markdown, through the app's OWN tokenizer (`lib/canvas-md`'s `parseInline`) — the same
 *  one CanvasConversation uses, and deliberately NOT react-markdown, which is what pegged
 *  WebContent in the reading panels. It is a single pass that emits unmatched markers as literal
 *  text, so a lone backtick degrades to a backtick instead of eating the rest of the line.
 *
 *  Worth it because backticks are not an edge case here: 11% of the real store's dispatch tasks
 *  and 2 of 6 rows in chat.db carry them, and every one of those was rendering as raw punctuation
 *  around a path. */
function InlineText({ text }: { text: string }) {
  const spans = useMemo(() => (text.length > INLINE_CAP ? null : parseInline(text)), [text])
  if (!spans) return <>{text}</>
  return (
    <>
      {spans.map((s, i) => (s.code ? (
        <code
          key={i}
          data-channel-code
          style={{
            fontFamily: 'var(--font-mono)', fontSize: 11,
            // Neutral wash, not an accent: a path is not a state. Mirrors the canvas renderer's
            // `codeBg`, via the token so it tracks all six palettes.
            background: 'var(--overlay-medium)',
            // No `break-all`: it splits the chip mid-token on every line that runs short. The
            // body's `break-word` still rescues a chip too long for a line of its own, which is
            // the only case that actually needs breaking.
            padding: '0.5px 4px', borderRadius: 3,
          }}
        >
          {s.text}
        </code>
      ) : (
        <span
          key={i}
          style={{
            fontWeight: s.bold ? 600 : undefined,
            fontStyle: s.italic ? 'italic' : undefined,
            textDecoration: s.strike ? 'line-through' : undefined,
          }}
        >
          {s.text}
        </span>
      )))}
    </>
  )
}

/** A body, folded to CLAMP_LINES with a control to open it.
 *
 *  The control only appears when the text ACTUALLY overflows — measured, not guessed from a
 *  character count, because the panel is resizable and the same string wraps differently at every
 *  width. A "Show more" on a body that is already whole is a control that does nothing, and the
 *  measure is re-taken on resize for the same reason. */
function ChannelBody({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const measure = useCallback(() => {
    const el = ref.current
    if (!el || expanded) return
    // +1 absorbs sub-pixel line-height rounding, which otherwise reports a 6-line body as
    // overflowing its own 6-line clamp.
    setOverflows(el.scrollHeight > el.clientHeight + 1)
  }, [expanded])

  useLayoutEffect(() => { measure() }, [measure, text])
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [measure])

  return (
    <>
      <div
        ref={ref}
        data-channel-text
        data-channel-clamped={!expanded && overflows ? '' : undefined}
        style={{
          fontSize: 12, lineHeight: 1.55, color: 'var(--fg)',
          maxWidth: PROSE,
          // `break-word`, NOT `anywhere`. Both let an over-long token break rather than overflow,
          // but `anywhere` breaks EAGERLY — it will split a path to tighten the current line even
          // when the whole token would fit on the next one. That is precisely the wrap this
          // widening exists to stop: `parseInline` renders paths as atomic chips, so a chip cut in
          // half mid-token costs more legibility than the long line it was avoiding.
          // (`anywhere` was added for a narrow-pane overflow that turned out to be the paused
          // banner, fixed at its source by stacking it — so the eager break was buying nothing.)
          whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'break-word', marginTop: 2,
          ...(expanded ? {} : {
            display: '-webkit-box',
            WebkitBoxOrient: 'vertical' as const,
            WebkitLineClamp: CLAMP_LINES,
            overflow: 'hidden',
          }),
        }}
      >
        <InlineText text={text} />
      </div>
      {overflows && (
        <button
          data-channel-more
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          style={{
            marginTop: 3, padding: 0, background: 'none', border: 'none', outline: 'none',
            cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 9,
            textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--fg-muted)',
            transition: 'color 120ms ease',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--fg)' }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--fg-muted)' }}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </>
  )
}

function ChannelRow({ entry, projectId, continuation, narrow, onApprove, onReject }: {
  entry: ChannelEntry
  projectId: string
  /** Same author as the row above, close in time: the identity is already on screen, so this row
   *  drops the avatar and the name and keeps everything that varies. */
  continuation?: boolean
  /** The pane is too narrow to spend 64px on an action rail — the prose needs it more. The AVATAR
   *  stays even here: it is the identity channel this whole layout is built around, and dropping
   *  it would cost more than the 36px it occupies. */
  narrow?: boolean
  onApprove?: (projectId: string, id: string) => void
  onReject?: (projectId: string, id: string) => void
}) {
  const [hover, setHover] = useState(false)
  const [copied, setCopied] = useState(false)
  const [focused, setFocused] = useState(false)
  const accent = entry.authorRole?.accent
  // The raw DispatchRecord id, recovered from the prefixed entry id, for the approval handlers.
  const dispatchId = entry.kind === 'dispatch' ? entry.id.slice('dispatch:'.length) : null
  const held = !!entry.chip.actionable && !!dispatchId
  return (
    <div
      data-channel-row={entry.id}
      data-channel-continuation={continuation ? '' : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        // FULL-BLEED: the row's background and hit area run edge to edge, and its own horizontal
        // padding is what insets the content. That split is the design — the row is full width,
        // the paragraph is not.
        display: 'flex', justifyContent: 'flex-start',
        padding: continuation ? `3px ${INSET}px` : `10px ${INSET}px 3px`,
        background: hover ? 'var(--overlay-subtle)' : 'transparent',
        // No transition on the background: at this row height a fade reads as lag, and the feed
        // is live enough already.
      }}
    >
      {/* SHRINK-TO-FIT, not `width: 100%`. The action rides this wrapper's right edge, so if the
          wrapper always claimed the full ROW_MAX the action would sit at the ceiling regardless of
          how much was actually said — measured at the 900px ceiling, a five-character "Done." left
          it 877px from its own last word. `fit-content` makes the wrapper hug its widest child
          (capped at ROW_MAX), so the action follows the text instead of the limit. */}
      <div style={{
        display: 'flex', gap: AVATAR_GAP, alignItems: 'flex-start',
        width: 'fit-content',
        maxWidth: narrow ? ROW_MAX - AVATAR_GAP - ACTION_W : ROW_MAX,
        minWidth: 0,
      }}>
      {/* CIRCLE — lane vocabulary. Accent tint + a STATIC hairline (a colour-changing border on a
          radiused element re-rasterizes in WKWebView), initials through laneTextColor so they
          clear 4.5:1 on the three light palettes where a raw accent collapses to ~1.4. A human or
          unresolved author gets a neutral fill instead of a borrowed lane colour.
          On a continuation the gutter is HELD OPEN and left empty, so every body in a run keeps
          the same left edge — the column is what makes the run read as one speaker. */}
      {continuation ? (
        <span aria-hidden style={{ flexShrink: 0, width: AVATAR }} />
      ) : (
        <span
          data-channel-avatar
          style={{
            flexShrink: 0, width: AVATAR, height: AVATAR, borderRadius: '50%',
            display: 'grid', placeItems: 'center',
            background: accent ? `color-mix(in srgb, ${accent} 16%, transparent)` : 'var(--overlay-medium)',
            border: `1px solid ${accent ? `color-mix(in srgb, ${accent} 38%, transparent)` : 'var(--border)'}`,
            // Plain --fg, not laneTextColor. Identity lives in the DISC — its accent tint and
            // hairline — and in the author name beside it; the two letters inside do not have to
            // carry it a third time, and making them do so cost legibility. The row now lifts to
            // --overlay-subtle on hover, and on that lighter backdrop a raw lane ink measured
            // 4.11 on Mr Pink dark: under the 4.5 floor, and only WHILE HOVERING, which is a
            // state no static screenshot catches.
            color: accent ? 'var(--fg)' : 'var(--fg-muted)',
            fontSize: 9.5, fontWeight: 600, letterSpacing: '0.02em', lineHeight: 1,
          }}
        >
          {channelInitials(entry.authorLabel)}
        </span>
      )}

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap' }}>
          {!continuation && (
            <span data-channel-author style={{
              fontSize: 11.5, fontWeight: 600,
              color: accent ? laneTextColor(accent) : 'var(--fg)',
            }}>
              {entry.authorLabel}
            </span>
          )}
          {/* WHO IS TALKING TO WHOM is the primary axis of a channel, and this was tertiary ink —
              9.5px muted mono, byte-identical to the timestamp beside it. The arrow stays muted
              (it is punctuation); the NAME steps up to body ink and size so the routing reads
              before the metadata does. */}
          {entry.targetLabel && (
            <span style={{
              fontSize: 11, color: 'var(--fg-muted)', whiteSpace: 'nowrap',
              // nowrap keeps `→ Design` from breaking after the arrow, but in a narrow pane a long
              // lane name then pushed the row's content past the scroller. Truncate instead.
              minWidth: 0, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              →{' '}
              <span data-channel-target style={{
                fontWeight: 500, color: 'color-mix(in srgb, var(--fg) 82%, transparent)',
              }}>
                {entry.targetLabel}
              </span>
            </span>
          )}
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--fg-muted)', fontVariantNumeric: 'tabular-nums' }}>
            {localTime(entry.at)}
          </span>
          {/* An ACTIONABLE state gets a shape, not just an ink. `2 queued` and `held · needs your
              approval` are the two things in this feed you might still have to do something
              about, and at 8.5px a colour swap alone was not carrying them against a row of
              `delivered`. A transparent tint, per house style — never a solid accent fill, and no
              border, so nothing colour-changing lands on a radiused element. */}
          <span
            data-channel-chip
            data-channel-chip-actionable={isActionableChip(entry.chip) ? '' : undefined}
            style={{
              fontFamily: 'var(--font-mono)', fontSize: 8.5, textTransform: 'uppercase',
              letterSpacing: '0.06em', color: TONE[entry.chip.tone],
              ...(isActionableChip(entry.chip) ? {
                padding: '1.5px 6px', borderRadius: 'var(--radius-sm)',
                background: `color-mix(in srgb, ${TONE[entry.chip.tone]} 13%, transparent)`,
              } : null),
            }}
          >
            {entry.chip.label}
          </span>
        </div>
        {/* Prose, in the body face: this is what an agent said, not a protocol line. */}
        <ChannelBody text={entry.text} />
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

        {/* RIGHT-EDGE FURNITURE — the affordance the centred column had nowhere to put. It sits at
            ROW_MAX rather than the pane's edge, so it stays within reach of the message it acts on.
            Revealed on hover, but ALSO whenever it has keyboard focus: a control that only exists
            under a pointer is unreachable by keyboard, and `visibility` rather than unmounting is
            what keeps it in the tab order at all.
            The focus ring is a `box-shadow` — the house rule forbids browser focus rings, and this
            is the feed's first interactive furniture, so it needed a real one of its own rather
            than nothing. A shadow also dodges the WKWebView colour-changing-border trap. */}
        {!narrow && (
        <button
          data-channel-copy={entry.id}
          onClick={() => {
            navigator.clipboard?.writeText(entry.text).then(() => {
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1200)
            }).catch(() => { /* clipboard blocked — say nothing rather than lie */ })
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          title="Copy this message"
          aria-label="Copy this message"
          style={{
            flexShrink: 0, alignSelf: 'flex-start', marginTop: 1,
            width: ACTION_W, boxSizing: 'border-box',
            // OPACITY, not `visibility: hidden` — that removes the element from the tab order
            // entirely, so the focus state below could never fire and the control was reachable
            // by pointer only. (This is not the "recede content with opacity" the house rule
            // forbids: that is about legibility of visible text; this is fully hidden or fully
            // shown, never in between.) It keeps its space at rest ON PURPOSE — the usual
            // hover-affordance rule is that a grip must not reserve space, but here reserving it
            // is what stops the prose re-wrapping every time the pointer crosses a row.
            opacity: hover || focused ? 1 : 0,
            pointerEvents: hover || focused ? 'auto' : 'none',
            transition: 'opacity 120ms ease',
            padding: '2px 7px', borderRadius: 'var(--radius-sm)', border: 'none',
            background: 'var(--overlay-medium)',
            // Full --fg, not --fg-muted. This control is invisible until you hover or focus it, so
            // there is nothing for it to recede BEHIND — and at --fg-muted on an --overlay-medium
            // chip it measured 2.99:1 on Mr Pink light, under the 3:1 floor. The `copied`
            // confirmation is carried by the WORD changing, not by the ink.
            color: 'var(--fg)',
            boxShadow: focused ? 'inset 0 0 0 1px var(--accent)' : 'none',
            cursor: 'pointer', outline: 'none',
            fontFamily: 'var(--font-mono)', fontSize: 9, textTransform: 'uppercase',
            letterSpacing: '0.08em',
          }}
        >
          {copied ? 'copied' : 'copy'}
        </button>
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
      {/* Capped and left-anchored, on the same INSET as the header and the rows. A full-bleed
          textarea at 2000px is as unreadable to write into as it is to read. */}
      <div style={{ maxWidth: COMPOSER_MAX + INSET * 2, padding: `10px ${INSET}px 12px`, boxSizing: 'border-box' }}>
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
