# Operator as a herdr client — result (2026-08-06)

## Headline answer: no, the tailer does not survive a remote session — not degraded, categorically absent

herdr's protocol has **no mechanism at all** to read, tail, or sync a session's transcript
file, local or remote. Grepped every `worktree/agent/pane/workspace/session/tabs/events`
schema module in herdr's source for any `read_file`/`sync`/`download` RPC — the only
file-adjacent surface is `pane.read`, which returns the **rendered terminal buffer**
(`visible`/`recent`/`recent-unwrapped`/`detection`), not a file on disk. Claude Code's own
`SessionStart` hook (`herdr-agent-state.sh`) does capture the transcript's path
(`agent_session_path`) — but only stores it as a string, for one purpose: replaying
`claude --resume <id>` if the herdr *server itself* restarts. It is never read, tailed, or
parsed for content, by design (source: `docs/.../session-state.mdx`, table row "Claude
Code | 6 | `claude --resume <id>`").

What herdr gives you instead, for Claude Code specifically, is a **5-value enum**
(`idle`/`working`/`blocked`/`done`/`unknown`) derived by regex-matching the *rendered
screen* against a rule table (`src/detect/manifests/claude.toml`, matching things like
`"do you want to proceed?"`, `'^\s*❯'`, Braille spinner ranges) — herdr's own docs state
this plainly: *"Claude Code state comes from Herdr's screen manifest detection"*
(`integrations.mdx:138`), placing it in the **"Session identity"** integration tier, a
notch below the **"Lifecycle authority"** tier a handful of other agents (Pi, OpenCode,
Kilo, MastraCode…) get via hook-authored semantic state. This is a real downgrade from
what `transcript.rs` extracts today — no thinking text, no full `tool_result` content, no
token usage, no `caller`/`parent_tool_use_id` subagent nesting, no dispatch-sentinel text
to parse.

**Split by locality, since the answer isn't the same both ways:**

- **Local herdr-hosted lane**: the tailer survives *trivially* — herdr just spawns
  `claude` as a normal child via `portable_pty` (confirmed at `src/pty/backend/unix.rs`),
  so the CLI still writes `~/.claude/projects/<slug>/<uuid>.jsonl` to the same local
  filesystem exactly as today. Operator's tailer doesn't need anything **from** herdr for
  this — it can keep reading the file directly, completely bypassing herdr's protocol.
- **Remote herdr-hosted lane**: the transcript sits on the remote box's filesystem, and
  there is no way through herdr's protocol to reach it. The tailer goes **completely
  blind** — not degraded to a slower poll, absent. All Operator would have for a remote
  Claude Code session is the same 5-value screen-scraped enum every other shallow-tier
  agent gets.

This single fact does most of the work for the rest of this report: it means "become a
herdr client" and "keep the rich transcript signal" are mutually exclusive for any
session that actually uses herdr's headline feature (remote execution). For local
sessions, herdr would sit **underneath** Operator's existing mechanism without improving
it.

---

## The rest of "what it would cost," answered against the brief's own list

**1. The transcript tailer** — answered above. Local: unaffected, herdr not in the loop.
Remote: no substitute exists.

**2. The dispatch sentinels** — `OPERATOR-DISPATCH`/`OPERATOR-REPLY` are regex-parsed out
of the transcript's assistant text. Same split as the tailer: **irrelevant** for a local
lane (still reading the same local file, no reason to route through herdr), **worse — impossible** for
a remote lane (nothing to parse without transcript access). One genuinely good finding
here: the MCP artifact plane already in flight (`operator__report`/`task_status`,
`dev/mcp-control-plane-spike.md`) is a lane-**initiated** tool call from inside the
Claude Code process itself — that direction is transport-agnostic to where the process
runs, local or remote. **That work is the actual right answer to "how does a remote lane
tell Operator anything," not routing through herdr's transcript-free protocol.** Worth
noting as a point in favor of the plan already underway, independent of this brief.

**3. Per-project ports** — confirmed no herdr solution exists. Grepped every doc page for
`port|tunnel|forward|expose`; the only hits are unrelated. A remote dev server's port has
no herdr-provided path back to the client — same gap Operator has today, unimproved.
(A third-party client, `dcolinmorgan/herdr-remote`, markets a bolt-on tunnel — unaudited,
noted only as circumstantial evidence the community felt this gap too.)

**4. Worktrees** — herdr has real, working CRUD (`worktree.list/create/open/remove`,
`src/worktree.rs` + `src/app/worktrees.rs`, 913+2392 lines, tested) with genuine
base-branch selection on create — directly comparable to the "stale base inherited" fix
Operator's own worktree-architecture recommendation calls for. **But there is no
age-based reaper anywhere in it** — grepped for `prune|reap|stale|age_|cleanup|orphan`
across every worktree module; the only hits are git's own admin-dir prune (inline, not a
policy) and an unrelated concurrency-conflict error code. So: herdr's worktree CRUD does
**not** obsolete the registry+reaper design from
`dev/briefs/2026-08-05-worktree-architecture-RESULT.md` — that work still has to be built,
on herdr or off it.

**5. The renderer** — still needed either way; herdr does not hand a client structured,
pre-rendered UI state. Even herdr's own flagship web client doesn't take the documented
JSON base64-frame path for real-time rendering — it vendors herdr's **private,
undocumented, bincode wire protocol** instead, pinned to an exact protocol number
(`herdr-web/docs/vendoring.md`: *"Terminal wire baseline: protocol 19"*), specifically
because *"the bridge depends on private API and wire protocol details that are not
exposed as a stable Herdr library or daemon API."* Operator's xterm.js DOM renderer and
the newly-wired alacritty grid path are **not** obsoleted by this — a herdr integration
would still need a terminal emulator on Operator's side, and the highest-fidelity path to
it is itself an undocumented, version-pinned dependency, not a stable surface.

**6. What Operator keeps** — nearly everything, by the above: projects, roster, charters,
dispatch (as designed, unaffected for local), tasks/diff, the chat surface, the terminal
renderer. What *would* become genuinely redundant if adopted broadly: `PtyManager`'s
spawn/kill/reattach plumbing and `alloc_port`'s local-port bookkeeping for herdr-hosted
lanes specifically — but only for those lanes, and only the process-ownership layer, not
the transcript/chat/dispatch layer above it.

---

## One thing the brief assumed that turned out to already be handled

The brief frames "persistence across app restarts" as a clean win, citing tonight's
WKWebView-respawn incident. **Operator already has this for local sessions.** `lib.rs:308`
and the surrounding re-attach machinery (`DashboardView.tsx`'s `reattached` tab flag,
the boot-time "adopt a surviving pty" effect) exist specifically because pty children
already survive a renderer reload/app restart today, and Operator already re-adopts them.
The bugs found in `2026-08-05-forget-and-sidebar-restart-RESULT.md` were **rehydration
logic bugs that fire during that existing re-attach path** (`archivedAt` cleared by an
unguarded upsert, `HashMap` iteration order randomizing sidebar position) — not evidence
the pty itself was dying. herdr wouldn't have prevented that incident: it would still need
its own re-attach/rehydration step on the client side, with the exact same class of bug
possible. The one piece of "outlives the window" Operator genuinely lacks today is **real
remote execution** — that's the actual net-new value on the table, not restart survival.

---

## Also answered

**Migration shape**: per-lane, not all-or-nothing, and there's already a precedent for
exactly this shape in this codebase — `stream-json-alongside-pty-RESULT.md` landed on "a
lane is either a terminal lane or a structured lane, chosen at spawn, never both." A herdr
lane would fit the same mold: a `sessionKind`/`hostedBy` flag at spawn, terminal-mode
lanes untouched. Given the transcript-blindness finding, this shape isn't optional — it's
required, since a herdr-hosted **remote** lane cannot offer what a pty-hosted local lane
does today, and hiding that difference from the user would be dishonest.

**Dependency risk**: real, and not fully offset by the star count. Positives: Apache-2.0
(relicensed from AGPL-3.0 in v0.8.0, lowering embedding risk), a real versioned
control-protocol with a checkable `protocol_mismatch` and a generated JSON Schema, a
maintained `CHANGELOG.md` with an explicit breaking-changes section. Negatives: `gh api`
confirms **one person (`ogulcancelik`) authored ≈82% of all commits** (1,100 of ~1,338),
with the next-largest contributors being CI bot accounts — and `CONTRIBUTING.md` makes
this structural, not incidental: *"Herdr does not accept unsolicited pull requests"*,
restricted to an allowlist, because *"we control the agents that work on Herdr."* 24.7k
stars sitting on a ~4-month-old, functionally single-maintainer, closed-PR-gate project is
a real bus-factor risk for anything load-bearing — and the one surface that would be most
load-bearing for Operator (terminal rendering fidelity) is the private, unstable one, not
the documented one.

**Does it duplicate what we just built?** No, and this is worth stating plainly since the
brief worried about it directly: the worktree-lifecycle registry/reaper work is not
duplicated by herdr (herdr has create/remove CRUD but no reaper — see §4 above), and the
MCP artifact-plane work is actively the *right* answer to the one problem herdr can't
solve (getting information out of a remote lane) rather than being made redundant by it.
Neither piece of work in flight should be paused or reconsidered because of this brief.

---

## Recommendation: don't adopt — the one narrow exception is a labeled, low-stakes experiment, not a plan

**Score: don't adopt for Claude Code lanes as they exist today.** The core trade herdr
offers is real remote execution in exchange for the entire depth of Operator's current
signal (thinking, full tool results, token usage, subagent structure, dispatch sentinels)
on any session that uses it — and Claude Code specifically gets herdr's shallow tier, not
its deep one, so there's no "multi-provider for free" upside riding along either. That's
not a good trade for the lane types Operator's product is actually built around
(orchestration, dispatch, structured review) — it's a good trade only for a use case
Operator doesn't currently serve at all: "I just want to check on a long-running agent
from my phone while away from my machine," where a 5-value status enum plus raw terminal
bytes is genuinely sufficient.

**The smallest experiment that would prove or kill even that narrow case**: install herdr
locally, wrap **one** manually-launched Claude Code session with it (`herdr` in front of
`claude`, no Operator code involved), and drive `pane.read`/`agent list`/`events.subscribe`
against it by hand to confirm the 5-value state and raw-byte pane read genuinely work as
documented — outside Operator's spawn path entirely, zero product-code risk, answers
"is the shallow tier good enough to be worth anything" before committing to a
`hostedBy: 'herdr'` spawn-time flag. Do not build the remote-execution integration itself
until that confirms the shallow signal is actually usable for a real check-in workflow —
if it isn't, there's no reason to build anything further here at all.
