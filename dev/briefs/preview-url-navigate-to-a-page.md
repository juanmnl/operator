# Brief — the preview URL bar clears itself, and cannot take a path

**Lane: Code.** Write your result to `dev/briefs/preview-url-navigate-to-a-page-RESULT.md`.

## The complaint

"I should be able to navigate to other urls on preview, not just click and clear the host/url,
keep it so i can add a specific page after it."

You cannot browse to a page in the preview. You can only re-point it at a root.

## Cause — two defects in one control, `src/renderer/components/session/AppPreviewPanel.tsx`

**1. The editor opens EMPTY when nothing is pinned** (`:305`)

```tsx
<input autoFocus defaultValue={override ?? ''} placeholder="port or URL" … />
```

`override` is the *pinned* target and is `null` whenever the preview auto-resolved a port — which
is the common case. The thing on screen is `display` (`:199`), not `override`. So clicking the host
throws away what you were looking at and hands you a blank 90px field. That is the "click and
clear" exactly.

**2. `commitOverride` cannot parse a path** (`:184`)

```tsx
if (/:\/\//.test(v)) next = v                       // full URL
else if (/^\d{2,5}$/.test(v)) next = v              // bare port
else if (/^localhost(:\d+)?$/.test(v) || /^[\w-]+(\.[\w-]+)+/.test(v)) next = `http://${v}`
setOverride(next)                                   // ← `/settings` matches nothing → null
```

`/settings` hits no branch, so `next` stays `null` and the pin is CLEARED. Typing a page actively
un-pins the preview.

## What I want

1. **Open the editor with what is on screen.** Prefill from `display` (the full URL, so the path is
   visible and editable), not from `override`. Select-all on focus so wholesale replacement is
   still one gesture, not a manual clear.
2. **Accept a path.** `/settings`, `/docs/intro?q=1#top` — resolve against the current origin
   (`new URL(v, display)` does this correctly, including `..` and query/hash). A bare `settings`
   with no leading slash is ambiguous against the existing host rule (`/^[\w-]+(\.[\w-]+)+/`); pick
   one reading, make it predictable, and say which you chose and why.
3. **Widen the field.** 90px cannot show `localhost:1432/docs/intro`. Size it to the content it now
   has to hold without destabilising the 30px toolbar row.
4. **Keep a way to un-pin.** Clearing to empty currently removes the override and returns to
   auto-resolution. That must survive — it is the only way back to "follow whatever this session is
   serving", and with a prefilled field it is no longer the accidental default.

## The trap that will bite you

`onBlur` commits (`:308`). Today the field is usually empty, so blurring without typing is
harmless. **Once it is prefilled with `display`, a blur with no edit would PIN the auto-resolved
URL** — silently converting a session that follows its own dev server into one nailed to whatever
port it happened to be on. That is a behaviour change the user never asked for and would not see
until the port moved.

Commit only a value that differs from the prefill. Escape must still cancel outright (`:310`).

## Also worth knowing

- The iframe is **cross-origin**: we cannot observe in-app navigation. `route` (`:205`) is the URL
  *we* loaded, not where the user has since clicked. So the bar shows our last commanded URL and
  cannot track the app's own routing — do not try to make it, and do not let it claim otherwise.
- `overrideUrl` (`:29`) expands a bare port to localhost. A full URL with a path must pass through
  it unchanged — check it does.
- The pin persists to `localStorage` under `overrideKey` and is shared per session. A pinned URL
  with a path is now a possible stored value; make sure a stale one still loads.
- `pickPreviewUrl` / `portOf` (`lib/preview-port.ts`) parse these strings. `portOf` on a URL with a
  path must still find the port, or the multi-server picker stops marking the live one.

## Done means

You can click the host, see `localhost:1432`, type `/settings` on the end, press Enter, and land on
that page; clearing the field returns to auto-resolution; blurring without editing changes nothing;
`npm test` green; `npx tsc --noEmit` clean. Add unit coverage for the parse — path, full URL, bare
port, host, empty — in the style of `lib/preview-port`'s existing tests.
