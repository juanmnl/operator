# Preview — address bar + server picker

**Design, 2026-08-24. Design only; nothing here is built.** Covers the two reported problems
(wrong server, no subpage), the address bar, the server picker, and the selection rule as a
decision table.

---

## 0. What was checked, and the five findings the design rests on

| # | Finding | Where | Consequence |
|---|---|---|---|
| 1 | **`alloc_port` deliberately shares ONE reserved port across every lane in the same cwd.** "same cwd → same port"; a sibling joining returns `(port, shared=true)`. There is a test named for it. | `lib.rs:438-462`, test `alloc_port_shares_one_port_across_lanes_in_the_same_cwd` (`lib.rs:2450`) | For N lanes in the project root, `reserved` is **identical**. `pickPreviewUrl` ranks that shared value highest. This is the wrong-server bug at its root: the current rule prefers the one signal that cannot distinguish lanes. |
| 2 | **`port_free` is checked only at allocation time.** Nothing re-verifies ownership afterwards. | `lib.rs:373-378, 438` | An orphaned dev server from a previous run, or any unrelated app, binding the reserved port later makes it "answer" with zero attribution — and the current rule shows it. |
| 3 | **`sniffed` is proof; `reserved` is a request.** A sniffed port came from a `http://localhost:PORT` banner printed *in this lane's own pty*; the comment calls it "this session's by construction". | `lib.rs:316-323, 469-478` | The precedence is **inverted today**. Fixing that one ordering is most of problem (1). |
| 4 | **The renderer physically cannot probe titles.** `ping()` is `fetch(url, {mode:'no-cors'})` → an *opaque* response: no status, no headers, no body, by spec. | `AppPreviewPanel.tsx:34-40` | The framework/title probe **must** live in Rust. There is no HTTP client in `Cargo.toml`, so it is a hand-rolled localhost GET over the `TcpStream` `port_alive` already uses — no new dependency, matching the repo's hand-roll idiom (`canvas-md`, no react-markdown). |
| 5 | **Back/forward cannot use the iframe's history.** The preview is cross-origin to the Tauri renderer, so `contentWindow.history` throws. The panel's own code already concedes it: *"the URL WE loaded, not any in-app navigation the user did afterwards"*. | `AppPreviewPanel.tsx:417` | Back/forward walk **Operator's own address history**, and the UI must not imply otherwise. §7. |

Two smaller ones, both worth fixing while nearby:

- `DEV_RE` matches `localhost`, `127.0.0.1` and `[::1]` — but **not `0.0.0.0`**, which Rails,
  Django, Docker-hosted servers and `vite --host` all print. A lane serving there is never
  attributed, so the panel falls back to the reserved port — the other half of the same bug.
  (`lib/terminal.ts:64`)
- `detectDevServerPort` takes the **first** match in the tail. A lane that prints its web and
  API URLs on one line only ever announces the first. That directly undercuts the "several
  servers, pick one" story the picker promises. (`lib/terminal.ts:77`)

---

## 1. The evidence model — the thing the current code is missing

Every candidate port carries *evidence*, and the evidence is not all the same strength. Naming
the tiers is what makes the selection rule writable:

| Tier | Evidence | What it actually proves |
|---|---|---|
| **P** | The user pinned it for this session | Nothing about ownership — but it is a decision, and decisions win. |
| **S** | **Sniffed** — a banner printed in *this lane's pty* | This lane's process is serving there. Proof. |
| **R⁻** | **Reserved, not shared** — Operator allocated it to this lane alone | This lane was *asked* to serve there. Not proof. |
| **R˅** | **Reserved, shared** — a sibling in the same cwd holds the same reservation | Cannot distinguish this lane from its siblings. Actively ambiguous. |
| **C** | Another live session **claims** the port (its own sniff, or its reservation) | Evidence it is **not** ours. |
| **∅** | Alive but no lane claims it | An orphan, or an unrelated app. |

`session_ports` today returns a bare `Vec<u16>` — the tiers are erased before the frontend ever
sees them, which is why `pickPreviewUrl` has nothing better to reason with than "is the
reserved one in the list". The fix starts in the backend: **return the evidence, not just the
numbers.**

---

## 2. The selection rule, as a decision table

`chooseTarget(servers, pinned, path)` in `lib/preview-target.ts`. Pure, and this table *is* its
test table. Rows are evaluated top to bottom; first match wins.

| # | Pinned | This lane sniffed & alive | Reserved alive | Reserved shared | Claimed by another lane | → Shows | Badge | Auto? |
|---|---|---|---|---|---|---|---|---|
| 1 | yes | – | – | – | – | the pin | `pinned` (+ `⚠ another lane` if C) | user's choice |
| 2 | no | **yes** | – | – | – | lowest sniffed port | `this lane` | **auto** |
| 3 | no | no | yes | no | no | reserved | `reserved · unconfirmed` | **auto** |
| 4 | no | no | yes | no | **yes** | **nothing** | — | never |
| 5 | no | no | yes | **yes** | no | **nothing** | — | never |
| 6 | no | no | yes | **yes** | yes | **nothing** | — | never |
| 7 | no | no | no | – | – | **nothing** | — | never |

**Three changes from today, and each maps to a reported symptom:**

- **Row 2 outranks rows 3–6.** Sniffed beats reserved, always. Today the reserved port wins
  whenever it answers (`preview-port.ts:33`), which is exactly backwards per finding #3.
- **Rows 4, 5 and 6 show nothing.** A reserved port that is alive but *unattributable* — shared
  with siblings, or claimed by another lane — is no longer displayed automatically. It becomes
  an **offer in the dropdown, with a warning**, never the automatic pick. This is the fix for
  "the panel often shows the wrong server", and it is deliberately conservative: the cost of
  row 5 is one extra click; the cost of the current behaviour is silently reviewing a sibling's
  build and reporting on it.
- **Row 3 keeps a badge.** Reserved-alive-and-unclaimed is *probably* ours and is shown — but it
  says `unconfirmed`, because finding #2 means an orphan can sit there. Honest, not paranoid.

Row 2's tie-break stays **lowest port**, and for the reason already written down in
`preview-port.ts`: the pick must not flip as the OS reorders its socket list.

**What rows 4–7 render is not a blank panel** — it is the no-server state of §6, which *names*
what is answering on the reserved port and says it is deliberately not being shown.

---

## 3. The address bar

One row, in the existing `PANEL_SUBHEAD_H` (30) band. The origin is a **chip that opens the
picker**; the path is the **editable part**. That split is what makes the brief's requirement
structural rather than a promise: changing the server touches the chip and never the path field.

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ◀ ▶ ⟳ │ ● localhost:5173 ▾ │ /settings/billing                │ Fit 375 768 1280 │ ⋯ │ 30
├──────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                      │
│                        ┌──────────────────────────────────┐                          │
│                        │                                  │                          │
│                        │   the running app                │                          │
│                        │                                  │                          │
│                        └──────────────────────────────────┘                          │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

- **`●`** is the reach dot — `--color-success` when answering, `--fg-muted` while checking,
  `--color-error` when down. It sits *inside* the origin chip because reach is a property of the
  server, not of the address.
- **The path field** is a plain input, `--overlay-subtle` ground, no border until focus, no focus
  ring (house rule) — focus is a `--border` → `color-mix(--accent 45%, --border)` edge change on
  a 4px-radius element, which is the one place the repo already accepts it (`retryBtn`, the
  editing input). `Enter` navigates, `Esc` reverts to the loaded path.
- **Empty path shows `/`** as placeholder ink, never a blank field — a blank reads as broken.
- **`⋯`** collapses Interact/Annotate/Inspect/↗ when the row is tight. The toolbar already
  carries seven controls; adding four more without a collapse would break at the width the
  right panel leaves (a 460px panel open on a 1280 window leaves ~800px here).

**Path persistence.** `operator.preview.path.<storageKey>`, mirroring the existing
`operator.preview.port.<storageKey>`. Written on navigate, re-read on session switch (the panel
is not remounted per session — the same trap `overrideKey` already documents at
`AppPreviewPanel.tsx:63-69`).

**Preserved across server change, by construction:** the target URL is composed as
`origin + path` at render time, from two independently-stored pieces. Switching from `:5173` to
`:1423` recomposes with the same path. If the new server doesn't have that route it shows its
own 404 — which is the truthful outcome, and better than silently resetting to `/` and hiding
that the servers differ. A `↩ /` chip appears beside the field whenever the path isn't `/`.

Narrow (the panel-open case, ≈600px available):

```
│ ◀ ▶ ⟳ │ ● :5173 ▾ │ /settings/billing              │ Fit ▾ │ ⋯ │
```

The origin chip drops `localhost`, never the port — the port is the identity.

---

## 4. The server picker

A `PopMenu` from the origin chip. Two groups and two verbs, and every row says **what it is
serving** and **who it belongs to**:

```
        ╭ SERVERS FOR THIS LANE ──────────────────────────────────╮
        │ ● :5173   Vite · operator                    this lane  │
        │ ● :4000   Express · api                      this lane  │
        │ ● :1423   Vite · operator              ⚠ another lane   │
        │ ○ :1424   —                              not answering  │
        ├─────────────────────────────────────────────────────────┤
        │   Other port or URL…                                    │
        │   Scan localhost for servers                            │
        ╰─────────────────────────────────────────────────────────╯
```

- **Second column is the probe** — `framework · title`, from §5. When the probe hasn't returned
  (or the port isn't HTTP) it is an em dash, not a spinner: a row that can be picked shouldn't
  look busy.
- **Third column is the evidence**, in words, not jargon: `this lane` (S), `reserved` (R⁻),
  `⚠ another lane` (C), `⚠ shared with 2 lanes` (R˅), `⚠ unclaimed` (∅). Transparent badge,
  hairline border only on the warning rows, text in `WARN_INK`
  (`color-mix(in srgb, var(--color-warning) 50%, var(--fg))` — the roster's existing warning ink,
  already contrast-checked across all six palettes). No fill, on any row.
- **`○` vs `●`** is alive vs not. A dead candidate is still listed — "the port Operator reserved,
  which nothing is answering on" is information, and hiding it is what makes the empty state feel
  like a bug.
- **`Other port or URL…`** opens the existing free-text commit (`commitOverride` already accepts
  a bare port, a host, or a full URL — that logic is good and stays).
- **`Scan localhost for servers`** keeps the existing blind probe of `COMMON_PORTS`, but its
  results are now **labelled with the same evidence column** — today the scan offers a sibling's
  server as a bare `localhost:5173` button with no attribution at all
  (`AppPreviewPanel.tsx:625-633`).

Picking a row **pins** it (existing behaviour, and right — an explicit choice must survive the
port set shifting). Picking the row that is already auto-selected **unpins**, the same
click-the-lit-option-to-clear gesture `Segmented` uses everywhere else in the app.

---

## 5. The probe

New Rust command, replacing `session_ports` for this panel:

```rust
#[tauri::command]
fn preview_servers(id: String, probe: bool, mgr: State<Arc<PtyManager>>) -> Vec<PreviewServer>

struct PreviewServer {
  port: u16,
  alive: bool,
  sniffed: bool,            // this lane's own banner
  reserved: bool,
  shared_reservation: bool, // another lane in the same cwd holds the same reservation
  claimed_by: Vec<String>,  // other live terminal ids whose sniff/reservation covers this port
  probe: Option<Probe>,     // { title, framework, status }
}
```

`claimed_by` is answered entirely from the maps already in `PtyManager` (`ports`, `sniffed`) —
**in-process, no process inspection**. That matters: the per-pid `lsof` walk is banned here
because it fires a TCC prompt per process, and the sniffed-set design exists precisely to avoid
it. Nothing in this command reintroduces it.

`probe` is a hand-rolled HTTP/1.1 `GET /` over the same `TcpStream::connect_timeout` used by
`port_alive`, reading at most 8KB:

- `framework` from `X-Powered-By` / `Server`, then body sniffing — `/@vite/client` → Vite,
  `__NEXT_DATA__` or `/_next/` → Next, `data-turbo` → Rails, `<script type="module" src="/src/`
  → Vite dev.
- `title` from the first `<title>`.
- Non-HTTP or no response inside the timeout → `None`. Never an error; a websocket or a database
  on that port is a normal thing to find.

**Probe cadence: on menu open, and once per port on its first alive transition.** Not on the 4s
poll — probing every candidate every four seconds is rude to the user's own dev server, and the
answer barely changes.

---

## 6. States

**No server for this lane yet** — and the point is that it *names what it is refusing to show*:

```
              No server for this lane yet

     Operator reserved :1423 for this lane, but nothing it
     started is answering there.

     ⚠ Something else is answering on :1423 — the Code lane's
       server. It isn't shown here, because it isn't this
       lane's app.

     [ Retry ]   [ Other port or URL… ]   [ Scan localhost ]
                 [ Show :1423 anyway ]
```

The last button is the escape hatch, and it is deliberately the quietest thing on the screen:
sometimes two lanes really are looking at one server and the user knows it. It pins, so the
choice is explicit and durable — never an automatic decision made on their behalf.

Variants: nothing at all answering on the reserved port → the middle paragraph and the
`Show anyway` button are both omitted (there is nothing to disclose). No reserved port at all
(a lane that never got one) → *"Operator didn't reserve a port for this lane."*

**Displaying a foreign server** (only ever reachable by an explicit pin) keeps a persistent,
dismissible strip above the frame — not a toast, because the condition persists:

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ⚠ :1423 is held by a process this lane didn't start — the Code lane's server.        │
│                                        Use this lane's :5173 →        Dismiss         │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Hairline `WARN_INK` border, transparent ground, no fill. `Dismiss` is per session + port, so it
does not re-nag; changing to a different foreign port raises it again.

**Loading / checking** — the reach dot goes `--fg-muted`, the frame keeps the last good render
rather than blanking. Blanking on every 3s re-ping is the flicker that makes a live preview feel
unstable.

**Server dies while shown** — the strip says `:5173 stopped answering` with `Retry`; the frame
holds its last paint, dimmed by *its own overlay*, never by group `opacity` on the card (house
rule).

**Themes.** `--fg`, `--fg-muted`, `--border`, `--overlay-subtle`, `--btn-bg`, `--accent`,
`--color-success`, `--color-error`, `WARN_INK`. No solid accent fills; no focus rings; no
opacity stacked on `--fg-muted`. Six palettes to verify against, not four — the standalone
"Light" identity was removed in favour of a per-identity light/dark toggle
(`themes/index.ts:31-49`).

---

## 7. Back / forward — say what they actually do

Per finding #5 they cannot walk the *app's* history. They walk **the addresses this bar
loaded** — a per-session stack of `{origin, path}`, capped at 50.

So the tooltips say so, in one line each: *"Back to the last address you opened here (not the
app's own history)."* That sentence is the whole design; the alternative — a control that looks
like a browser's back button and silently behaves differently — is worse than not shipping it.

The buttons **disable by absence of ink, not by grey chrome**: at the ends of the stack the
glyph drops to `--fg-muted` and the click is a no-op. No `disabled` attribute, no half-opacity
button.

Worth writing down for later: Operator *does* own a real webview in Inspect mode
(`previewInspectOpen`), and a webview it owns can report navigation. If back/forward over the
app's true history ever becomes worth it, the route is "always use the owned webview, not the
iframe" — not "try harder with the iframe". That is a much bigger change than this design, and
it is not proposed here.

---

## 8. Components and props

```
src/renderer/lib/preview-target.ts     chooseTarget() + composeUrl() — pure, tested (§2 IS the tests)
src/renderer/lib/preview-port.ts       portOf() stays; pickPreviewUrl() is DELETED, not deprecated
src/renderer/components/session/preview/
    PreviewAddressBar.tsx    ◀ ▶ ⟳ · origin chip · path field · overflow ⋯
    ServerMenu.tsx           the PopMenu, evidence badges, Other/Scan
    ForeignServerNotice.tsx  the warning strip
    NoServerState.tsx        the empty state, including "Show :NNNN anyway"
```

```ts
export function PreviewAddressBar(props: {
  origin: string | null            // "localhost:5173"
  path: string                     // "/settings/billing"
  reach: 'checking' | 'up' | 'down'
  pinned: boolean
  onPath(next: string): void       // navigate; commits to storage
  onOpenServers(): void
  canBack: boolean
  canForward: boolean
  onBack(): void
  onForward(): void
  onReload(): void
  /** Below this the origin chip drops "localhost" and the trailing controls collapse into ⋯. */
  compact: boolean
}): JSX.Element
```

```ts
export function ServerMenu(props: {
  servers: PreviewServer[]         // straight from preview_servers, evidence intact
  selectedPort: number | null
  pinnedPort: number | null
  onPick(port: number): void       // pins; picking the lit row unpins
  onOther(): void
  onScan(): void
  scanning: boolean
  scanned?: ScanHit[]              // blind-probe hits, carrying the same evidence column
}): JSX.Element
```

```ts
// The rule. Everything about "which server" lives here and nowhere else.
export function chooseTarget(
  servers: PreviewServer[],
  pinned: string | null,
  path: string,
): {
  url: string | null
  port: number | null
  confidence: 'pinned' | 'this-lane' | 'unconfirmed' | 'none'
  /** Set when the panel is deliberately NOT showing a live port. Drives §6's middle paragraph. */
  withheld?: { port: number; reason: 'another-lane' | 'shared' | 'unclaimed'; who?: string }
  warn?: string
}
```

`withheld` is the piece that keeps the empty state honest: without it the panel knows only that
it has nothing to show, and the "something else is answering on :1423" sentence — the one that
turns a confusing blank into an explanation — cannot be written.

**`AppPreviewPanel` keeps** the annotations, the inspector, the presets, the stage geometry, and
`commitOverride`'s parsing. It loses `pickPreviewUrl` and the inline URL button.

---

## 9. Build plan, in order

**S1 — `preview_servers` with evidence.** The Rust command returning per-port
`sniffed / reserved / shared_reservation / claimed_by`, resolved from the existing maps. No
probe, no UI.
*Verify:* two lanes in the project root both report `:1423` with `shared_reservation: true` and
each other in `claimed_by` — the exact configuration that produces the reported bug.

**S2 — `chooseTarget` + the decision table as tests, wired in.** `pickPreviewUrl` deleted.
No new chrome.
*Verify:* the wrong-server case stops reproducing — the panel goes to the no-server state
instead of showing the sibling's app. **The bug is fixed here, before any of the new UI exists**,
which is what makes the fix verifiable on its own.

**S3 — `DEV_RE` gains `0.0.0.0`, and the sniffer reports every match in the tail.** Two small
changes in `lib/terminal.ts`, each with a test.
*Verify:* a lane printing `http://0.0.0.0:3000` is attributed; a line carrying two URLs
announces both. This raises how often row 2 (the good row) applies, so it belongs before the
picker that advertises multiple servers.

**S4 — the address bar.** Origin chip, path field, path persistence, reload, the compact form.
*Verify:* the path survives a port change and a session switch; a 460px panel open on a 1280
window still renders the row without clipping.

**S5 — the server picker.** `ServerMenu`, evidence badges, pin/unpin, Other, Scan-with-labels.

**S6 — the probe.** The raw localhost GET in Rust, framework + title, on-open cadence.
*Verify:* Vite and Next labelled correctly; a non-HTTP port (a database) returns `None` fast and
never stalls the menu.

**S7 — the no-server state and the foreign-server strip**, both driven by `withheld`.

**S8 — back/forward** over the address stack, with the tooltips that say what they are.

**Not in scope, deliberately:** true in-app history (§7), an always-owned webview instead of the
iframe, HTTPS or remote-host probing, and any automatic use of a port no lane can claim.

---

## 10. Open questions

1. **Does anything but the panel call `session_ports`?** If not, `preview_servers` replaces it
   outright rather than sitting beside it — two commands answering nearly the same question is
   how the two drift. Check before S1.
2. **What should `shared_reservation` do when the siblings are the same project root and the
   user genuinely wants one shared preview?** Row 5 costs them one click per session, forever.
   If that turns out to be the common case rather than the rare one, the answer is a
   project-level "these lanes share a server" pin — not loosening the rule.
3. **Probe timeout budget.** A port that accepts a connection but never responds (a raw TCP
   service) will hold the probe open. 800ms is the proposed cap; worth confirming against a real
   database port before S6.
4. **`0.0.0.0` attribution is weaker than `localhost`.** A server bound to all interfaces is
   reachable by anything on the machine, so a banner is still proof *this lane printed it* but
   not that the lane is the only one there. Treat it as tier S anyway — the banner is the
   evidence, not the bind address — but note it if a false attribution is ever seen.
