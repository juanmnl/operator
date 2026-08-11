import { useEffect, useRef, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
import '@xterm/xterm/css/xterm.css'
import type { ITheme } from '@xterm/xterm'
import { isLightBackground, detectDevServerPort, findUrlAtColumn, stripOrnaments } from '../../lib/terminal'
import { buildTerminalOptions, getMacOptionIsMeta, scrollbackFor, shouldFitOnResize } from '../../lib/terminal-options'
import { registerTerminal, unregisterTerminal } from '../../lib/terminal-registry'
import { ghostProbeEnabled, installGhostProbe } from '../../lib/ghost-probe'
import { isAppChord } from '../../lib/key-routing'
import { persistFiles, imageFilesFrom } from '../../lib/paste-image'
import { base64ToBytes } from '../../lib/base64'
import { submitQueue } from '../../lib/submit-queue'

// Claude Code's composer-divider ornaments (👀/👣 and newer cycled pictographs) are
// decorative, not corruption. Strip them on EVERY path that writes to xterm — live
// output AND replayed history (an idle input box keeps the ornament from its last draw,
// so the history path matters). See lib/terminal `stripOrnaments` for the shared regex.
const decoder = new TextDecoder()

interface TerminalPaneProps {
  terminalId: string
  theme: ITheme
  active?: boolean
  /** Re-attaching to a surviving pty after a reload — replay its buffered
   *  scrollback on mount. Omitted/false for a freshly launched session (no
   *  history to replay, and fetching it would duplicate the first bytes). */
  replayHistory?: boolean
  /** Suspend fitting while true (e.g. during a panel drag) — the terminal holds
   *  its grid and fits once when this returns to false, for a smooth resize. */
  suspendFit?: boolean
  /** SPIKE: load xterm's WebGL renderer (the one that corrupted in older WKWebView) to
   *  re-test it on today's WebKit. Off = xterm's built-in DOM renderer. */
  webgl?: boolean
  onTitleChange?: (title: string) => void
  /** Fires with the port when a dev server announces itself in the output. */
  onDevServerDetected?: (port: number) => void
}

export function TerminalPane({ terminalId, theme, active = true, replayHistory = false, suspendFit = false, webgl = false, onTitleChange, onDevServerDetected }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  // Timestamp (ms) of the last pty chunk, and a pending deferred-fit timer. A
  // fit() that changes cols/rows sends a SIGWINCH to the pty; if that lands while
  // Claude Code is mid-redraw (between its cursor-up and the rewrite of its status
  // block) the redraw desyncs → stacked/garbled "Infusing…" status lines. So we
  // hold fits until output has been quiet briefly (see handleResize).
  const lastDataAtRef = useRef(0)
  const pendingFitRef = useRef<number | null>(null)
  // WKWebView drops/mis-composites xterm's rapid partial-row repaints under Claude
  // Code's cursor-up rewrites → stale/superimposed rows ("overprint"). xterm's
  // BUFFER is correct, so we force a full re-render of all visible rows from the
  // buffer — throttled during streaming + once on settle — to wipe the overprint.
  const refreshTimerRef = useRef<number | null>(null)
  const lastRefreshAtRef = useRef(0)
  // Output that arrived while this pane was HIDDEN — buffered instead of written,
  // because xterm renders even when not visible, and several background panes
  // rendering at once overload WKWebView and corrupt the VISIBLE pane (the
  // "worsens after the first session" report). Flushed when the pane activates.
  const bgBufferRef = useRef<string[]>([])
  const bgBufferLenRef = useRef(0)
  // Latest suspendFit without re-running the construction effect.
  const suspendFitRef = useRef(suspendFit)
  suspendFitRef.current = suspendFit
  // True while an IME composition is in progress — the custom key handler must not
  // intercept keys (let the textarea commit the composed text through onData).
  const isComposingRef = useRef(false)
  // Latest `active` without making it a dep of the construction effect (which must
  // not re-run on activation). Used by the window-focus refocus guard.
  const activeRef = useRef(active)
  activeRef.current = active
  // Latest onDevServerDetected without making it an effect dep (would re-subscribe
  // the pty stream every render). The rolling tail lets the "Local:" banner be
  // matched even when it's split across two pty chunks; the last port we reported
  // is remembered so we only fire on a change.
  const devServerCbRef = useRef<typeof onDevServerDetected>(onDevServerDetected)
  devServerCbRef.current = onDevServerDetected
  const outTailRef = useRef('')
  const lastDevPortRef = useRef<number | null>(null)

  // Renderer: xterm's built-in DOM renderer — TerminalSurface does NOT pass `webgl`.
  // WKWebView corrupts WebGL's texture atlas (tofu cells, garbled rows; xtermjs/xterm.js#5816).
  // A 2026-07 spot-test looked clean and v0.8.0 shipped WebGL, but real long sessions still
  // corrupted WHOLESALE, so the GPU bug is NOT fixed in this WebKit. Do not re-enable `webgl`
  // without a sustained-session soak test — see TerminalSurface's header for the history.
  // Quiet window (ms) after the last pty chunk before a deferred fit is allowed.
  // Claude's spinner updates leave gaps well over this, so fits still apply
  // between frames; only mid-burst fits are held back.
  const FIT_QUIET_MS = 150

  const doFit = useCallback(() => {
    // Never fit against a hidden/collapsed container (display:none → 0 width).
    // Doing so would send a ~1-column size to the pty and make Claude Code
    // re-render its TUI narrow, which then sticks in the scrollback.
    const el = containerRef.current
    if (!el || el.offsetWidth < 50 || el.offsetHeight < 20) return
    if (fitRef.current) {
      try {
        fitRef.current.fit() // no-op unless the computed cols/rows actually changed
      } catch {
        // ignore fit errors during teardown
      }
    }
  }, [])

  const handleResize = useCallback(() => {
    // Only the pane on screen fits: an inactive pane's ResizeObserver / window-resize callback
    // must not reach the pty (see `shouldFitOnResize` for the measurement and the trade). Also
    // held during a panel drag — the effect below fits once when it releases. A pane mounted
    // while inactive still gets its true initial size: `ensureInitialFit` fits and resizes
    // directly, not through here, and activation refits.
    if (!shouldFitOnResize(activeRef.current, suspendFitRef.current)) return
    if (pendingFitRef.current != null) {
      clearTimeout(pendingFitRef.current)
      pendingFitRef.current = null
    }
    // If output is actively streaming, defer the fit until it quiets so a resize
    // never interrupts an in-flight TUI redraw. Re-checks on each retry.
    const sinceData = Date.now() - lastDataAtRef.current
    if (sinceData < FIT_QUIET_MS) {
      pendingFitRef.current = window.setTimeout(() => {
        pendingFitRef.current = null
        handleResize()
      }, FIT_QUIET_MS - sinceData + 10)
      return
    }
    doFit()
  }, [doFit])

  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      // Shared font/behavior config (font stack, weights, unicode, scrollback, and
      // macOptionIsMeta — now defaulting to false so ⌥ composes characters; see
      // lib/terminal-options.ts). The harnesses build the same options so they
      // can't drift from production.
      ...buildTerminalOptions(theme),
      // OSC-8 hyperlinks (Claude Code emits them for URLs). Without our own
      // handler xterm falls back to a default that calls confirm() — which Tauri
      // blocks ("dialog.confirm not allowed") so the link never opens. Route them
      // through the system opener instead. App-specific, so it stays here.
      linkHandler: {
        activate: (_event, uri) => {
          if (window.operator?.openExternal) window.operator.openExternal(uri)
          else window.open(uri, '_blank')
        },
        allowNonHttpProtocols: true,
      },
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    // Upgrade xterm's character-width tables from its built-in Unicode 6 to a modern,
    // grapheme-cluster-aware width model. Claude Code lays out its TUI with a modern
    // wcwidth (string-width / Unicode 15-16: emoji & many symbols are 2 cells, ZWJ
    // sequences cluster); on Unicode 6 those came out wrong, so the cursor column drifted
    // and Claude Code's redraws landed on the wrong row — the overlapping/garbled lines.
    // The graphemes addon (successor to addon-unicode11, which was really Unicode 12) is
    // closer to Claude Code's table and adds grapheme clustering. Needs allowProposedApi.
    term.loadAddon(new UnicodeGraphemesAddon())
    // The addon registers '15' and '15-graphemes' and activates the latter; pin it
    // explicitly (plain '15' would select the non-grapheme provider).
    term.unicode.activeVersion = '15-graphemes'
    // Clicking a link opens it in the system browser (via Tauri's opener);
    // falls back to window.open elsewhere.
    term.loadAddon(new WebLinksAddon((_event, uri) => {
      if (window.operator?.openExternal) window.operator.openExternal(uri)
      else window.open(uri, '_blank')
    }))

    // WebGL renderer (loaded after open()). Falls back to xterm's DOM renderer if the addon
    // can't init OR the GPU context is later lost (driver reset, sleep/wake) — disposing the
    // addon on context loss reverts xterm to DOM instead of freezing on a dead canvas.
    term.open(containerRef.current)
    if (webgl) {
      try {
        const gl = new WebglAddon()
        gl.onContextLoss(() => { try { gl.dispose() } catch { /* already gone */ } })
        term.loadAddon(gl)
      } catch (e) {
        console.warn('[xterm] WebGL addon failed to init — staying on the DOM renderer', e)
      }
    }

    termRef.current = term
    fitRef.current = fitAddon
    // Expose this live instance so app-level code (e.g. the ⌘K buffer-dump
    // diagnostic) can read its buffer. Unregistered on dispose below.
    registerTerminal(terminalId, term)

    // Key routing: app chords (Cmd+K/N/B/W, Cmd+1..9) are owned by the window
    // shortcut handler in DashboardView. Decline the Cmd (meta) variants here so
    // xterm emits no bytes for them and they bubble to that handler — Ctrl+<key>
    // are terminal control codes (^W werase, ^K kill-line) and must reach the pty,
    // so they're NOT declined. During IME composition decline nothing.
    // A HUMAN IS TYPING IN THIS LANE → disarm its pending rescue CR.
    //
    // Every dispatch arms a bare CR for its terminal, to submit a draft the TUI swallowed the
    // CR for. On an observed terminal that CR is up to RESCUE_AFTER_MS (30s) away, and the
    // user's keystrokes go into the SAME TUI composer — so the rescue would submit whatever
    // half-written line is sitting there. Reported as "it sends my message with it, half
    // baked". The queue always had the disarm; nothing called it for typing.
    //
    // Hooked on the real KEY event, not on `term.onData` as first proposed, because onData is
    // not user-only: xterm fires it for terminal replies too — device attributes and cursor
    // position (`InputHandler.ts` triggerDataEvent at :1672, :2663) and, decisively, the focus
    // in/out reports `ESC[I` / `ESC[O` that go out whenever the pane gains or loses focus with
    // `sendFocus` on (`CoreBrowserTerminal.ts:271,295`). Disarming on those would kill the
    // rescue on an unattended lane merely because something focused it — the feature's whole
    // purpose, silently gone. A keydown is a person.
    const disarmRescue = () => {
      // `pending` is set only while a submission is actually awaiting its verdict, so the
      // common keystroke does one Map.get and stops. cancelNudge itself is a counter bump and
      // a delete — O(1), no allocation — but there is no reason to run it on every character.
      if (submitQueue.pending(terminalId)) submitQueue.cancelNudge(terminalId, 'typing')
    }
    term.attachCustomKeyEventHandler((e) => {
      if (isComposingRef.current) return true
      // App chords are declined below and emit no bytes, so they are not typing INTO the lane.
      if (e.type === 'keydown' && e.metaKey && isAppChord(e)) return false
      if (e.type === 'keydown') disarmRescue()
      return true
    })

    // Track IME composition on xterm's hidden textarea. xterm already commits the
    // composed result through onData; we only need the flag for the key handler.
    const textarea = term.textarea
    const onCompositionStart = () => { isComposingRef.current = true }
    const onCompositionEnd = () => { isComposingRef.current = false }
    textarea?.addEventListener('compositionstart', onCompositionStart)
    textarea?.addEventListener('compositionend', onCompositionEnd)

    // Clipboard image paste: if the clipboard holds an image (e.g. a screenshot
    // copied with Cmd+Ctrl+Shift+4), persist its bytes to a temp file and write
    // the path — parity with drag-drop (handleDrop). Non-image pastes fall through
    // to xterm untouched, so bracketed paste of text still works.
    const onPaste = async (e: ClipboardEvent) => {
      // Pasting into the lane is a person too, and a paste lands in the same composer — so it
      // disarms for BOTH branches below, not just the image one.
      disarmRescue()
      const images = imageFilesFrom(e.clipboardData)
      if (images.length === 0) return
      e.preventDefault()
      e.stopPropagation()
      const paths = await persistFiles(images, window.operator.savePastedImage)
      // Bracketed paste so Claude Code converts the path to a native `[Image #N]` (see handleDrop).
      if (paths.length) window.operator.terminalWrite(terminalId, `\x1b[200~${paths.join(' ')}\x1b[201~`)
    }
    textarea?.addEventListener('paste', onPaste, { capture: true })

    // Refocus when the window regains focus (or the tab becomes visible after the
    // idle webview reload) while this pane is active, so typing lands without a
    // click. activeRef avoids making `active` a dependency of this effect.
    const refocusIfActive = () => { if (activeRef.current) termRef.current?.focus() }
    window.addEventListener('focus', refocusIfActive)
    const onVisibility = () => { if (document.visibilityState === 'visible') refocusIfActive() }
    document.addEventListener('visibilitychange', onVisibility)

    // Composer-ghost probe, OFF unless `operator.terminal.ghostProbe` is '1' in localStorage —
    // with the flag unset nothing here runs: no listener, no global, no cost. When it is on,
    // Ctrl+Alt+Shift+G (or `window.__ghostProbe()`) dumps the bottom 8 rows' buffer text against
    // their live DOM text, which is the one comparison that separates a stale DOM from stale
    // pixels. It is strictly READ-ONLY on purpose: a repaint would clear the ghost before it could
    // be captured. See lib/ghost-probe.ts.
    const disposeProbe = ghostProbeEnabled()
      ? installGhostProbe(term, terminalId, () => activeRef.current)
      : undefined

    // Fit only once the container actually has width. Fitting against a 0/tiny
    // container sends a tiny column count to the pty, so Claude Code renders its
    // TUI at ~10 cols and that wrapping gets baked into the scrollback.
    const ensureInitialFit = () => {
      const el = containerRef.current
      if (!el) return
      if (el.offsetWidth < 50) {
        requestAnimationFrame(ensureInitialFit)
        return
      }
      try { fitAddon.fit() } catch { /* */ }
      window.operator.terminalResize(terminalId, term.cols, term.rows)
      // Defer-launch: exec Claude at the fitted width now that the box is real (see
      // terminal_spawn's DEFERRED LAUNCH). Idempotent — the backend no-ops if already started.
      try { window.operator.terminalStart?.(terminalId, term.cols, term.rows) } catch { /* ignore */ }
    }
    ensureInitialFit()
    term.focus()

    // The pty is opened at a default size in Rust a moment before our first fit
    // lands, and the rounded inset card / layout can settle a frame later. Re-
    // assert the real size a couple of beats after launch so Claude Code lays out
    // its TUI against the correct width (avoids an initial mis-wrapped frame).
    // Timers are cleared on unmount.
    const kick1 = setTimeout(() => handleResize(), 250)
    const kick2 = setTimeout(() => handleResize(), 800)

    // Forward keystrokes to pty
    term.onData((data) => {
      window.operator.terminalWrite(terminalId, data)
    })

    // Resize pty on terminal resize
    term.onResize(({ cols, rows }) => {
      window.operator.terminalResize(terminalId, cols, rows)
      // WebGL leaves stale cell backgrounds / offsets after a reflow — e.g. collapsing the
      // sidebar widens the terminal, then scrolling back shows the diff's +/- background
      // bars misaligned from the text. The heal loop only runs during output, so an idle
      // session never self-corrects. Force a clean re-render once the new size settles:
      // drop the glyph atlas (so it re-uploads at the new metrics) and repaint every row.
      requestAnimationFrame(() => {
        const t = termRef.current
        if (!t) return
        try { (t as unknown as { clearTextureAtlas?: () => void }).clearTextureAtlas?.() } catch { /* no atlas */ }
        try { t.refresh(0, t.rows - 1) } catch { /* disposed */ }
      })
    })

    // Title changes
    if (onTitleChange) {
      term.onTitleChange(onTitleChange)
    }

    // Receive data from pty — returns unsubscribe function
    // Sniff a dev-server URL. We used to anchor on a "Local:" banner, but Claude
    // Code COLLAPSES subprocess output ("+5 lines") so that line never streams —
    // only Claude's own prose ("Dev server is running: http://localhost:5273/")
    // does. So match a localhost URL directly. Keep a short tail so a URL split
    // across two chunks still matches.
    const detectDevServer = (chunk: string) => {
      const cb = devServerCbRef.current
      if (!cb) return
      // Pure rolling-tail scan (see lib/terminal): strips colour escapes, matches a
      // localhost URL, dedups against the last port, and returns the next 512-char
      // tail (escapes intact) so a banner split across chunks still strips cleanly.
      const { port, tail } = detectDevServerPort(outTailRef.current, chunk, lastDevPortRef.current)
      outTailRef.current = tail
      if (port !== null) { lastDevPortRef.current = port; cb(port) }
    }

    // Force xterm to repaint every visible row from its (correct) buffer. Marks all
    // rows dirty so the DOM renderer rebuilds them, clearing WKWebView's stale/
    // superimposed text. Throttled (mid-stream healing) + debounced (final settle).
    const forceRepaint = () => {
      // Only the visible pane repaints. Hidden panes (other sessions) repainting
      // would pile redundant term.refresh() work onto WKWebView and OVERWHELM it —
      // that's why corruption worsened when a second session opened. They repaint
      // on re-activation (see the active-change effect).
      if (!activeRef.current) return
      try { term.refresh(0, term.rows - 1) } catch { /* disposed */ }
    }
    // term.refresh() rewrites the row DOM, but WKWebView often marks that change
    // dirty WITHOUT flushing it to the compositor, so a stale glyph lingers on
    // screen even though the DOM is correct (the residual ✳/👀; sub-row/per-glyph
    // in current captures — see dev/garble-triage.md, 2026-07-22). The heal is to
    // force a compositor COMMIT right after the refresh, which flushes the pending
    // row update. WHICH invalidation trick actually commits, and why the others
    // were rejected (this was measured by mechanism, not by the visual harness —
    // headless WebKit renders correctly, so it has no stale rect to prove a heal
    // against; only the live app can confirm efficacy):
    //   • translateZ(0) ↔ ''  — NO-OP, the previously shipped version. Both values
    //     are the IDENTITY matrix, so WebKit collapses the change to nothing and no
    //     commit happens (project_terminal_ornament_width_drift.md, 2026-07-20).
    //   • a NON-identity sub-pixel translate ('' → translate3d(0, 0.02px, 0) → '')
    //     — CHOSEN. The matrix genuinely changes, forcing a style recalc + a
    //     compositor commit that flushes the dirty rows. 0.02px is far below one
    //     device pixel so nothing visibly moves, and the element stays fully OPAQUE.
    //   • opacity nudge (0.99 ↔ 1) — BURNED: shipped v0.8.5, reverted v0.8.6. The
    //     sub-1 frame let the splash/dashboard layer bleed THROUGH the terminal.
    //     Never reintroduce opacity OR visibility/content-visibility toggles — same
    //     blank/transparent-frame bleed.
    //   • width/padding nudge — REJECTED: it changes layout, tripping xterm's
    //     ResizeObserver → a full buffer reflow (the one thing we must not do here).
    // 2026-07-29, after a live sighting where the heal ran throughout and it still
    // garbled (dev/briefs/garble-heal-gap.md; lead 1 — the 6s output gate — was traced
    // and DIED, the gate was open the whole time). Two things were wrong here, and
    // neither was the one the brief guessed:
    //
    //   • THE NUDGE WAS OFTEN NEVER PAINTED. Setting a style and reverting it in the
    //     NEXT rAF is not a frame apart: rAF callbacks run at the START of a frame's
    //     rendering steps, so a set/revert pair inside one rendering opportunity can
    //     coalesce and the compositor never sees the changed value. Measured in this
    //     WebKit (dev/briefs/garble-lead2-RESULT.md): reverting on the next rAF painted
    //     the intermediate value in 7/25 samples; holding it across TWO rAFs, 11/25.
    //     So the heal was skipping its own commit most cycles — it "ran" without
    //     forcing anything. `holdFrame` below is the fix, and it is why the mechanism
    //     is now a helper rather than two inline copies.
    //   • BUMPING 0.02px IS POINTLESS. Measured raster deltas against an untransformed
    //     baseline: 0.02px changed 2.93% of pixels (max channel delta 194), 0.34px and
    //     0.5px changed 3.05% (same max). The rasterisation flip has already happened
    //     at 0.02px and a larger value buys nothing — it only shifts text antialiasing
    //     further. Do not "try a bigger number"; that lead is closed by measurement.
    //
    // The escalation the comment above anticipated is `rebuildLayer` below.
    const holdFrame = (apply: () => void, revert: () => void) => {
      apply()
      // Two rAFs: the first callback runs before this frame paints, so only the second
      // guarantees a painted frame carried the changed value.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => { if (termRef.current === term) revert() })
      })
    }
    const hardRepaint = () => {
      if (!activeRef.current) return
      try {
        term.refresh(0, term.rows - 1)
        const el = term.element as HTMLElement | null
        if (el) holdFrame(
          () => { el.style.transform = 'translate3d(0, 0.02px, 0)' },
          () => { el.style.transform = '' },
        )
      } catch { /* disposed */ }
    }
    // The heavier escalation: promote the element to its own compositing layer and drop
    // it again. Each transition destroys and rebuilds the layer's backing store, so a
    // stale raster CANNOT survive it — where a transform nudge only asks the compositor
    // to re-commit pixels it may believe are still valid. Measured pixel-identical while
    // applied (0 of ~400k pixels changed, at dPR 1 and 2), unlike the opacity and
    // visibility toggles that were burned in v0.8.5 — nothing bleeds through, because
    // the element never stops being opaque or painted.
    // Heavier per call than `hardRepaint` (it allocates a viewport-sized backing store),
    // so it is wired ONLY to the ≤1/sec heal, never to settle and never per-chunk.
    const rebuildLayer = () => {
      if (!activeRef.current) return
      try {
        term.refresh(0, term.rows - 1)
        const el = term.element as HTMLElement | null
        if (el) holdFrame(
          () => { el.style.willChange = 'transform' },
          () => { el.style.willChange = '' },
        )
      } catch { /* disposed */ }
    }
    const scheduleRepaint = () => {
      const now = Date.now()
      if (now - lastRefreshAtRef.current > 180) {
        lastRefreshAtRef.current = now
        forceRepaint()
      }
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
      refreshTimerRef.current = window.setTimeout(() => {
        lastRefreshAtRef.current = Date.now()
        hardRepaint() // settle: force a real recomposite to clear lingering glyphs
      }, 90)
    }
    // The throttled per-write repaint can fall behind during long, sustained
    // output (the corruption "starts the longer the session" — drift accumulates
    // faster than it heals). A steady low-frequency repaint, running whenever
    // output is recent, continuously re-syncs the viewport regardless of write
    // cadence. Cheap (≤1 viewport repaint/sec) and pauses when the session is idle.
    // The periodic heal runs the LAYER REBUILD, not the nudge: this is the once-a-second
    // slot the brief reserved for the heavier mechanism, and it is the one that can clear
    // a rect the compositor believes is still valid. The gate stays — a genuinely idle
    // session must not spin — and it was traced as open during the sighting anyway.
    const healInterval = window.setInterval(() => {
      if (Date.now() - lastDataAtRef.current < 6000) rebuildLayer()
    }, 1000)

    const BG_CAP = 512_000 // ~512KB of background output retained per hidden pane
    // Flush output buffered while hidden, in order, before any live/active write.
    const flushBg = () => {
      if (!bgBufferRef.current.length) return
      const buf = bgBufferRef.current.join('')
      bgBufferRef.current = []
      bgBufferLenRef.current = 0
      try { term.write(buf) } catch { /* disposed */ }
    }
    const writeLive = (data: string) => {
      lastDataAtRef.current = Date.now() // gate fits while output is streaming
      detectDevServer(data) // scan raw output for the dev-server banner (cheap, no render)
      const clean = stripOrnaments(data) // drop Claude's 👀/👣 divider ornaments (see top)
      if (activeRef.current) {
        flushBg() // catch up anything buffered while hidden, preserving order
        term.write(clean, scheduleRepaint) // repaint after xterm parses+renders the chunk
      } else {
        // Hidden: buffer, don't render (see bgBufferRef). Trim oldest past the cap.
        bgBufferRef.current.push(clean)
        bgBufferLenRef.current += clean.length
        while (bgBufferLenRef.current > BG_CAP && bgBufferRef.current.length > 1) {
          bgBufferLenRef.current -= bgBufferRef.current.shift()!.length
        }
      }
    }
    // On (re)attach, replay the pty's buffered output first so a session that
    // survived a webview reload shows its prior scrollback instead of a blank pane.
    // Subscribe to live data BEFORE fetching the snapshot so no byte is dropped;
    // bytes that arrive before the snapshot is written are queued, then flushed.
    // (The small [subscribe, snapshot] overlap may duplicate a few bytes — harmless
    // and preferable to losing output. Skipped when there's no history, i.e. a fresh
    // launch, so a normal session is unaffected.)
    let historyDone = false
    const pending: string[] = []
    const unsubData = window.operator.onTerminalData((id, data) => {
      if (id !== terminalId) return
      if (!historyDone) { pending.push(data); return }
      writeLive(data)
    })
    const flushPending = () => {
      for (const d of pending) writeLive(d)
      pending.length = 0
      historyDone = true
    }
    // Only re-attached panes replay history; a fresh launch has none, and fetching
    // it would duplicate the first bytes over the [subscribe, snapshot] window.
    const historyP = replayHistory ? window.operator.terminalHistory?.(terminalId) : undefined
    if (historyP) {
      historyP.then((b64) => {
        // termRef is nulled on unmount; guard against writing to a disposed term.
        if (termRef.current === term && b64) {
          try { term.write(stripOrnaments(decoder.decode(base64ToBytes(b64)))) } catch { /* ignore */ }
        }
      }).catch(() => { /* no history */ }).finally(() => {
        if (termRef.current === term) flushPending()
      })
    } else {
      flushPending()
    }

    // Resize observer (container/layout changes) + a window resize listener
    // (OS-window resizes, which ResizeObserver can miss under WKWebView). Both
    // funnel through the same quiet-gated fit.
    const observer = new ResizeObserver(handleResize)
    observer.observe(containerRef.current)
    window.addEventListener('resize', handleResize)

    // Claude Code enables mouse tracking, which makes xterm forward the wheel to
    // the app instead of scrolling. When that's on (and we're not in an
    // alt-screen app that owns the screen), scroll the scrollback ourselves.
    const container = containerRef.current
    const onWheelCapture = (e: WheelEvent) => {
      const t = termRef.current
      if (!t || t.modes.mouseTrackingMode === 'none') return
      if (t.buffer.active.type !== 'normal') return
      const lines = e.deltaMode === 1 ? e.deltaY : e.deltaY / 24
      t.scrollLines(Math.round(lines) || (e.deltaY > 0 ? 1 : -1))
      e.preventDefault()
      e.stopPropagation()
    }
    container.addEventListener('wheel', onWheelCapture, { capture: true, passive: false })

    // Link clicks: when Claude Code has mouse tracking on (the common case — see
    // the wheel workaround above), xterm forwards the click to the pty as a mouse
    // report, so WebLinksAddon's own click never fires. The link still *hovers*
    // (decoration), but clicking does nothing. So when tracking is active we
    // resolve the URL under the pointer ourselves and open it, swallowing the
    // event before it becomes a mouse report. With tracking off we do nothing and
    // let WebLinksAddon handle it normally (avoids opening twice).
    const urlAtClick = (e: MouseEvent): string | null => {
      const t = termRef.current
      if (!t) return null
      // xterm's measured cell box + the screen element origin (private but stable).
      const core = (t as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } }; screenElement?: HTMLElement } })._core
      const cell = core?._renderService?.dimensions?.css?.cell
      const screen = core?.screenElement
      if (!cell || !screen || !cell.width || !cell.height) return null
      const rect = screen.getBoundingClientRect()
      const col = Math.floor((e.clientX - rect.left) / cell.width)
      const row = Math.floor((e.clientY - rect.top) / cell.height)
      if (col < 0 || row < 0) return null
      const line = t.buffer.active.getLine(t.buffer.active.viewportY + row)
      if (!line) return null
      return findUrlAtColumn(line.translateToString(false), col)
    }
    const onClickCapture = (e: MouseEvent) => {
      const t = termRef.current
      if (!t || t.modes.mouseTrackingMode === 'none') return // WebLinksAddon handles it
      if (e.button !== 0) return
      const url = urlAtClick(e)
      if (!url) return
      e.preventDefault()
      e.stopPropagation()
      if (window.operator?.openExternal) window.operator.openExternal(url)
      else window.open(url, '_blank')
    }
    // mousedown is where xterm builds the mouse report; intercept there too so the
    // click never reaches the pty, plus click for the actual activation.
    const swallowIfLink = (e: MouseEvent) => {
      const t = termRef.current
      if (!t || t.modes.mouseTrackingMode === 'none' || e.button !== 0) return
      if (urlAtClick(e)) { e.preventDefault(); e.stopPropagation() }
    }
    container.addEventListener('mousedown', swallowIfLink, { capture: true })
    container.addEventListener('mouseup', swallowIfLink, { capture: true })
    container.addEventListener('click', onClickCapture, { capture: true })

    return () => {
      clearTimeout(kick1)
      clearTimeout(kick2)
      if (pendingFitRef.current != null) clearTimeout(pendingFitRef.current)
      if (refreshTimerRef.current != null) clearTimeout(refreshTimerRef.current)
      clearInterval(healInterval)
      window.removeEventListener('resize', handleResize)
      unsubData()
      observer.disconnect()
      container.removeEventListener('wheel', onWheelCapture, { capture: true } as EventListenerOptions)
      container.removeEventListener('mousedown', swallowIfLink, { capture: true } as EventListenerOptions)
      container.removeEventListener('mouseup', swallowIfLink, { capture: true } as EventListenerOptions)
      container.removeEventListener('click', onClickCapture, { capture: true } as EventListenerOptions)
      textarea?.removeEventListener('compositionstart', onCompositionStart)
      textarea?.removeEventListener('compositionend', onCompositionEnd)
      textarea?.removeEventListener('paste', onPaste, { capture: true } as EventListenerOptions)
      window.removeEventListener('focus', refocusIfActive)
      document.removeEventListener('visibilitychange', onVisibility)
      disposeProbe?.()
      unregisterTerminal(terminalId)
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // `theme` is intentionally excluded — recreating the terminal on a theme
    // change would wipe the scrollback. It's applied in place below instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId, onTitleChange, handleResize])

  // Apply theme/contrast changes to the live terminal without recreating it.
  // The DOM renderer repaints from the new palette on the next frame — no atlas
  // to rebuild.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = theme
    term.options.minimumContrastRatio = isLightBackground(theme.background) ? 4.5 : 1
  }, [theme])

  // When a panel drag releases (suspendFit → false), fit once so the terminal
  // snaps to its final size in a single pass rather than reflowing every frame.
  useEffect(() => {
    if (!suspendFit) handleResize()
  }, [suspendFit, handleResize])

  // Focus/blur and refit when active state changes
  useEffect(() => {
    const term = termRef.current
    if (!term) return

    // Re-read the ⌥-as-Meta setting on activation so a change in Preferences takes
    // effect when you switch back to a terminal (no terminal recreate needed).
    term.options.macOptionIsMeta = getMacOptionIsMeta()

    // A hidden pane keeps a smaller buffer. Every session's terminal stays mounted (that rule
    // is what stops the pane blanking and the resize-hang), so a project with eight lanes was
    // holding eight × 10k lines of cells in one renderer — measured at 737MB resting, and
    // opening the heaviest project pushed WebKit into killing and respawning the renderer
    // mid-navigation. Lowering the option TRIMS the buffer immediately, which is the whole
    // point; see INACTIVE_SCROLLBACK for what that costs and why it is the right trade.
    term.options.scrollback = scrollbackFor(active)

    if (active) {
      // Flush output buffered while this pane was hidden (it didn't render in the
      // background to keep WKWebView load off the visible pane), in order, first.
      if (bgBufferRef.current.length) {
        const buf = bgBufferRef.current.join('')
        bgBufferRef.current = []
        bgBufferLenRef.current = 0
        try { term.write(buf) } catch { /* ignore */ }
      }
      term.options.cursorBlink = true
      try {
        fitRef.current?.fit()
      } catch {
        // ignore
      }
      // Repaint on becoming visible — it skipped repaints while hidden, so re-sync
      // the viewport to the buffer (also covers any drift from while it was backgrounded).
      try { term.refresh(0, term.rows - 1) } catch { /* ignore */ }
      term.focus()
    } else {
      term.options.cursorBlink = false
      term.blur()
    }
  }, [active])

  // Handle image / file drag and drop. A dragged macOS screenshot *preview* (the
  // one you grab before it saves to Desktop) carries image BYTES, not a file on
  // disk — and standard (Tauri) webviews never expose `File.path` anyway. So we
  // read the bytes and write them to a temp file via the backend, then drop that
  // path into the terminal. This makes "screenshot → drag straight in" work like
  // iTerm, so Claude Code can Read the image without it ever touching the Desktop.
  // (Needs `dragDropEnabled: false` in tauri.conf so the webview gets HTML5 DnD.)
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return
    // Persist each dropped file to a temp path (works for unsaved screenshots that
    // carry bytes but no File.path). Shared with the clipboard-paste handler.
    const paths = await persistFiles(files, window.operator.savePastedImage)
    // BRACKETED PASTE (ESC[200~ … ESC[201~), not a plain write: Claude Code only converts a
    // path to a native `[Image #N]` attachment when it arrives as a PASTE. A plain typed
    // write leaves the ugly literal path (the "didn't get shortened" bug).
    if (paths.length > 0) window.operator.terminalWrite(terminalId, `\x1b[200~${paths.join(' ')}\x1b[201~`)
  }, [terminalId])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  // Flush terminal — the content column already provides the rounded inset card,
  // so the terminal just fills it with a little breathing room (no second frame).
  return (
    <div
      ref={containerRef}
      onClick={() => termRef.current?.focus()}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      style={{
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        padding: 6,
      }}
    />
  )
}
