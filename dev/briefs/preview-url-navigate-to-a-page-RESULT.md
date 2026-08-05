# Result — you can browse to a page in the preview, and the bar no longer clears itself

Brief: `dev/briefs/preview-url-navigate-to-a-page.md`. Lane: Code.

## What landed

| file | change |
|---|---|
| `src/renderer/lib/preview-port.ts` | **new `resolvePreviewTarget(raw, base)`** — the whole parse, pure and testable, next to `portOf`/`pickPreviewUrl`. |
| `src/renderer/lib/preview-port.test.ts` | 8 new cases for it + a `portOf` case for a URL carrying a path. |
| `src/renderer/components/session/AppPreviewPanel.tsx` | prefill from `display`, select-on-focus, `commitIfChanged` (the blur trap), the parse swapped in, field widened, `data-preview-host` / `data-preview-url` hooks. |
| `dev/drive-preview-url.mjs` | **new driver**, 8 sections. |

Both defects are gone:

- **The editor opened blank.** `defaultValue={override ?? ''}` — and `override` is null whenever
  the preview auto-resolved, which is the common case. It now prefills from `host` (i.e. `display`
  with the scheme stripped, **path and query kept**), so clicking the host makes the text editable
  without changing it. `onFocus` selects all, so wholesale replacement is still one gesture.
- **`/settings` un-pinned instead of navigating.** It matched no branch, `next` stayed `null`, and
  `setOverride(null)` cleared the pin — typing a page actively un-pinned the preview. It now
  resolves against what is on screen.

Measured end to end, which is the brief's "Done means" verbatim:

```
1 at rest:   localhost:1421 ●   pinned=false   stored=null
2 editor opened with: "localhost:1421"     (was "")
4 after typing /settings:
    host   localhost:1421/settings ● ·pinned
    frame  http://localhost:1421/settings          ← the iframe actually went there
    stored http://localhost:1421/settings
7 after clearing: localhost:1421 ●   pinned=false   stored=null
```

## The parse, and the ambiguity I was asked to settle

`resolvePreviewTarget` is an ordered specification, because the readings genuinely overlap
(`localhost:1432/settings` is a host *and* contains a path):

| input | reading | result |
|---|---|---|
| `` | un-pin | `null` |
| `https://app.example.com/pricing` | full URL, verbatim | unchanged |
| `5173` | bare **port** | `"5173"` — stored as a port, not the expansion |
| `localhost` · `localhost:1432` · `example.com` · each `+/path` | host | `http://` + it |
| `/settings` · `docs/intro?q=1#top` · `..` | relative to `base` | `new URL(v, base).href` |

**The bare dotless word (`settings`) is read as a PATH.** The host rules require a dot or the
literal `localhost`, so `example.com` stays a host and `settings` does not. Reasons, in order: this
is a preview of *the session's own app*, where a path is overwhelmingly the intent; the rule states
in one sentence ("a dot or `localhost` makes it a hostname, everything else is a path"); and it
fails legibly either way — a 404 in the frame, not the silent no-op the old parse gave.

The residual cost, stated rather than hidden: a **dotted** bare token like `intro.html` reads as a
host. Write it `./intro.html` or `/intro.html` and it is a path again; both are tested.

Relative targets use **standard relative-URL semantics** — `new URL(v, base)`, exactly as a link on
that page would resolve — so `..` and `./` work as the brief asked. Consequence worth knowing: with
`display` at `…/docs/`, a bare `intro` lands on `/docs/intro`, not `/intro`. That is the same rule
a browser applies, not a special case.

Unresolvable input (a relative target with no `base`) returns `null`, i.e. un-pin. A target we
cannot resolve returns to auto-resolution rather than pinning something nobody typed.

## The trap, and where I went one step further than asked

> *"Once it is prefilled with `display`, a blur with no edit would PIN the auto-resolved URL."*

Real, and it is the one thing in here that would have shipped silently. `commitIfChanged` commits
only a value that differs from the prefill.

**I applied it to Enter as well as blur**, which the brief only asked for on blur. Pressing Enter on
an untouched prefill is the same "I didn't type anything" gesture, and two rules for two keys is
something no user could predict. The cost, which is real: you cannot pin the current URL by opening
the editor and confirming it — editing it to itself is indistinguishable from not editing at all.
I think that is the right trade (pinning the auto-resolved URL is precisely the silent conversion
the trap is about), but it is a judgement call and it is reversible in one line.

Escape still cancels outright. Clearing to empty still differs from the prefill, so the un-pin path
is untouched — §7 of the driver proves it end to end.

## The four "also worth knowing" items, each checked rather than assumed

1. **Cross-origin iframe.** Nothing here tries to observe in-app navigation. The bar still shows the
   URL *we* commanded; `route` is unchanged. The only new claim it makes is one we set ourselves.
2. **`overrideUrl` passes a full URL through unchanged.** It keys on `/:\/\//`, and every resolved
   path comes back absolute, so it is untouched. Asserted in driver §4 (`stored` is
   `http://localhost:1421/settings`, with no `localhost:` prefix bug).
3. **A stale stored pin with a path still loads.** Driver §5 reloads and lands on
   `localhost:1421/settings ·pinned`.
4. **`portOf` on a URL with a path.** Works (`new URL(...).port`), and is now covered by a unit test
   *and* by driver §5, which checks it by INK: exactly one of the two port buttons is accented, and
   it is `:1421` — the port inside the pinned path. Had `portOf` broken, the picker would have
   marked nothing.

## The field

90px could not show `localhost:1432/docs/intro`. It is now `flex: '1 1 0', minWidth: 90,
maxWidth: 260` — it grows into the toolbar's slack rather than taking a bigger fixed width, so on a
wide panel the presets still sit right (they carry `marginLeft: auto`) and on a narrow one the field
gives way first instead of overflowing the row. 90 stays as the floor, so it is never worse than
before. Measured 260px wide with the row still exactly **30px** (driver §2) — the toolbar does not
move.

Placeholder is now `port, URL, or /path`; the button's tooltip says the same.

## Verification

- `npx tsc --noEmit` — clean.
- `npm test` — **578 passed** (was 569; +9 new cases in `preview-port.test.ts`).
- `node dev/drive-preview-url.mjs` — 8 sections, all as expected:

```
1 auto-resolved to the reserved port: true
1 …and NOTHING is pinned: true
2 editor opened with: "localhost:1421"          (expect "localhost:1421", NOT "")
2 it is what the button said: true
2 selected for wholesale replacement: true
2 wide enough for a path: 260                   (was 90)
2 the 30px toolbar row did not move: 30
3 after an UNEDITED blur — nothing was pinned: true
3 …and the session still FOLLOWS its own server: true
4 the bar shows the page: true
4 it is PINNED and stored as a full URL: true
5 a pinned PATH survives a reload: true
5 the picker still marks the live port through the path: { ports: [':1421',':5173'], marked: ':1421' }
6 Escape cancelled: true
7 un-pinned and following the session again: true
8 a bare port pins as a port: { host: 'localhost:5173', stored: '5173' }
```

## Left out / known

- **The bar still cannot follow the app's own routing.** The iframe is cross-origin; the brief says
  not to try and I did not. If the user clicks a link *inside* the preview, the bar keeps showing
  the URL we last commanded. That remains a real gap, and the honest fix is the Inspect webview
  (Operator-owned, so it can report navigation) rather than anything in this control.
- **Driver noise, environmental:** `Fetch API cannot load http://localhost:3000/auth/staff` appears
  at the end of a run. That is the panel's own `ping` (which catches it) hitting a real server
  running on :3000 **on this machine** — not in the fixture, not from this change. It does not
  affect any assertion.
