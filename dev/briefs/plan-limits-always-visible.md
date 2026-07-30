# Brief — plan limits, permanently visible

User: *"we need a place to permanently show current session and weekly limits in the UI — it's
something I have to do by switching apps."* They currently read it from Claude's
Settings → Usage pane.

## The data source is SOLVED — do not invent one

`types.ts:565` already records that the % bars "come from Anthropic's servers and aren't
reproducible locally", and that is still true of any local derivation. But there is a **supported**
way to ask for them. Verified by running it:

```
$ claude -p "/usage"
You are currently using your subscription to power your Claude Code usage

Current session: 58% used · resets Jul 30 at 2am (America/Guayaquil)
Current week (all models): 38% used · resets Aug 4 at 1am (America/Guayaquil)
Current week (Fable): 0% used · resets Aug 4 at 12:59am (America/Guayaquil)

What's contributing to your limits usage?
…
```

Those three percentages matched the Settings pane exactly (58 / 38 / 0). So:

- **No undocumented HTTP endpoint. No reading credentials. No scraping a TUI.** Shell out to the
  CLI the app already depends on and parse plain text.
- The "what's contributing" section below is the SAME data `src-tauri/src/usage.rs` already computes
  locally (`compute_insights`). **Do not re-parse it** — keep using the local computation, which
  needs no subprocess. Only the three `%`-and-reset lines come from here.

## Build

### Rust — a new command beside `usage.rs`
Spawn `claude -p "/usage"`, capture stdout, parse tolerantly, return:

```rust
pub struct PlanLimits {
    pub session_pct: Option<u8>,      pub session_resets: Option<String>,
    pub week_pct: Option<u8>,         pub week_resets: Option<String>,
    /// The per-model weekly line ("Current week (Fable)"). Its LABEL is not fixed — it names
    /// whichever model the plan meters separately — so carry the label, never hardcode "Fable".
    pub model_label: Option<String>,  pub model_pct: Option<u8>, pub model_resets: Option<String>,
    pub fetched_at: String,
    /// Present when the CLI ran but said something we did not expect. Surfaced, never swallowed.
    pub note: Option<String>,
}
```

**Parse defensively — every field Optional.** This is another program's human-readable output and it
WILL change wording. Match on a loose shape (`Current session`, `Current week`, a `NN% used`) rather
than an exact string, and when a line does not match, return `None` for that field plus a `note` —
never a wrong number, never a panic, never a hang.

- **Timeout the subprocess** (~15s) and kill it on expiry. It is a network call behind a process
  spawn; the UI must not be able to wedge on it.
- **Never run it more than once at a time.** A mutex or in-flight flag — five refresh clicks must
  not spawn five processes.
- **Cache with a TTL of 5 minutes**, plus explicit manual refresh. Session limits move on the order
  of minutes, not seconds, and each read costs a process spawn plus a round-trip. Do not poll on a
  timer faster than that, and **never** poll per render.
- Handle the not-a-subscription case: a user on API billing gets different output. Absent data must
  render as absent, not as 0%.

### Where it lives — the RAIL FOOT, beside the Agents button

User's call, after considering the session actions footer and rejecting it: *"add it to a global
position, maybe next to the agents button."* Correct, and it is the only placement that works — the
actions footer renders solely inside a session, so a button there is absent at the gallery and with
nothing running, which is exactly when someone deciding what to launch wants to see their limits.
`ProjectRail` persists in every state.

**Depends on `dev/briefs/agents-hub-to-rail.md`** landing first (it establishes the Agents control in
the rail foot). Order in the foot becomes: **Agents · Usage · All projects · Open folder** — the two
cross-project *views* together, then the two *navigation* verbs, separated by the existing seam.

- **The control** uses the same `RailFoot` pattern as its neighbours (`ProjectRail.tsx:122`):
  icon-only at 44px, `aria-label` carrying the accessible name, title carrying the detail.
- **Show the number as a ring, not text.** 44px has no room for "58%" — so a ~22px circular track
  with an arc swept to the session percentage, `--accent` normally, `--status-compacting` past 75%,
  `--color-error` past 90%. That is the permanent glance the whole request is about; the modal is the
  reading. Render the ring empty (track only, no arc) when there is no data — **absent is not zero**.
- **Click opens the modal**, anchored to the control and dismissed by Escape / outside click — the
  house popover behaviour (`ProjectSwitcher`'s, in git history at `:32-49` of the deleted file).
  Hovering shows just `Session 58% · Week 38%` via the existing `useHoverCard`, so a glance never
  needs a click.

  Content, in the app's own vocabulary:
  - `Plan usage` title, and the plan name if `/usage` gives one.
  - One row per limit: label, `NN% used`, a bar, and the reset line beneath in 9.5px mono `--fg-muted`.
  - **The bar**: 4px tall, full width, `borderRadius: 2px`. Track `--overlay-subtle`, fill `--accent`
    → `--status-compacting` past 75% → `--color-error` past 90%. Fill width is a `%`.
    **No gradient, no glow, no animated fill.** Motion in this app means "busy"; a usage bar is not
    busy, and a bar that animates on open reads as loading.
  - Footer: `Updated 3m ago` + a Refresh control.
  - `font-variant-numeric: tabular-nums` on every percentage, so they do not jitter on refresh.

### One surface only

Do **not** also add a button to the session actions footer. Two routes to one popover is the
redundancy we just spent v0.11.0 removing from the sidebar header, and the rail is visible in every
state the footer is plus the ones it isn't. If the rail control ever feels too far away while working
in a session, say so in your result — that is a placement decision for the user, not a second button.

The data itself needs **no session and no project**: `claude -p "/usage"` spawns its own short-lived
process (verified with zero lanes running). So the ring is live at the gallery, on first launch,
before anything is scoped — which is the whole reason this placement is right.

**No cost figures anywhere.** Percentages and reset times only — the same rule as the capability
config. `$/Mtok` is not in scope and is a separate decision.

## Do NOT
- Do not read `~/.claude/.credentials.json`, the keychain, or any auth token. The subprocess owns
  auth; Operator never touches it.
- Do not call any Anthropic HTTP endpoint directly.
- Do not re-implement the "contributing factors" block — `usage.rs` already has it locally.
- Do not block app start on it. First paint must not wait for a subprocess; render the meter empty
  and fill it in.

## Traps
- The reset strings carry a timezone in parentheses. Show them verbatim rather than re-formatting —
  re-deriving a local time from an already-localised string is how you print the wrong hour.
- `claude` must be resolved the way the app already resolves it for `terminal_spawn` (a login shell
  finds it on PATH; a bare `Command::new("claude")` from a GUI app may not). Reuse that, don't
  hardcode `~/.local/bin/claude`.
- Never stack opacity on `--fg-muted`; the guard test fails the build.
- **The bar changes colour at its thresholds, so it must not carry a border** — a colour-CHANGING
  border on a border-radius element re-rasterizes in WKWebView. Fill and track only, border none.
- The modal must not trap focus badly: Escape closes, focus returns to the button. It is a popover,
  not a dialog — do not reach for a full-screen overlay.

## Verify
- `cargo test` — parser unit tests over: the real sample above; a missing model line; reworded
  labels; a percentage over 100; empty stdout; a non-subscription message; garbage. Every case
  returns `Ok` with `None`s and a `note`, never a panic.
- `npm test` + `npm run build` green.
- Assert the in-flight guard: two concurrent calls spawn one process.
- A new `dev/drive-plan-limits.mjs`: the footer button shows a percentage, opens the modal, the bars
  render at the right widths, Escape closes it, and with no data the button renders without a
  percentage rather than showing `0%` (absent is not zero — that distinction is the whole point).
- `node dev/drive-theme-pass.mjs` — all 6 palettes; the 75%/90% bar colours must be distinguishable
  from the normal fill on the three LIGHT ones, which is where accent-vs-warning collapses.

## Write your result to
`dev/briefs/plan-limits-always-visible-RESULT.md` — the parse shape, the real numbers it returned on
this machine, subprocess timing, and how it behaves when `/usage` output is unrecognised.
