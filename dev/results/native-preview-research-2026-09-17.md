# Can Preview show and inspect native apps? (2026-09-17)

Research only, no code changed. Answers a direct question from another lane: today Preview
(`AppPreviewPanel.tsx`, `electron/src/main/preview-inspect.ts`, `src/shared/preview-overlay.js`)
only knows how to show a **web dev server** — an iframe for Interact/Annotate, and a same-origin
`WebContentsView` with an injected script for Inspect/redlines/grid. Nothing in the current code
reads a native window, an AX tree, or a video frame. This asks what it would take to extend that
to Electron, SwiftUI/AppKit, Tauri, Catalyst, and the iOS Simulator, per SHOW / INSPECT / ANNOTATE.

Every claim below is tagged **VERIFIED** (a primary source was found — cited) or **INFERRED** (my
own reasoning from verified facts, or an anecdotal/secondary source, no primary doc). Research ran
as three parallel searches (capture+input, accessibility trees, CDP/WKWebView/sandbox); citations
are folded in by topic below, full list in Sources.

**One fact that shapes everything else, checked directly against this repo, not inferred:**
Operator's own build (`electron/build/entitlements.plist`) has hardened runtime but **no
`com.apple.security.app-sandbox` key at all** — it is a direct, notarized Developer-ID app, not
sandboxed. VERIFIED. That matters because App Sandbox is what actually forecloses cross-app AX
control and input forwarding (§5) — Operator's current packaging does not hit that wall.

---

## 1. SHOW — getting a live view of another app's window into Operator

**Electron / Tauri / SwiftUI / AppKit / Catalyst — same mechanism, since it's compositor-level,
not framework-aware:**

- `SCContentFilter.init(desktopIndependentWindow:)` captures exactly one window by `SCWindow`,
  independent of Space/desktop. VERIFIED —
  [Apple docs](https://developer.apple.com/documentation/screencapturekit/sccontentfilter/init(desktopindependentwindow:)).
  This is Swift/ObjC-only; no first-party Node/Electron binding exists. Getting frames into
  Operator's renderer needs a native addon or a small signed Swift helper process streaming frames
  (IOSurface / shared memory / local socket) to a `<canvas>`. INFERRED gap — searched specifically
  for "Electron + ScreenCaptureKit" and found none; nearest prior art is Rust SCK bindings
  ([screencapturekit-rs](https://github.com/svtlabs/screencapturekit-rs)) and a native (non-Electron)
  macOS app doing exactly this capture shape
  ([Sunshine PR #5511](https://github.com/LizardByte/Sunshine/pull/5511)) — the pattern is proven,
  the Electron glue is not built anywhere I could find.
- Latency: Apple's own pitch is GPU-composited, low-overhead capture (~1.9% of one core at 60fps +
  audio). VERIFIED, WWDC22 ["Meet ScreenCaptureKit"](https://developer.apple.com/videos/play/wwdc2022/10156/).
  A specific end-to-end ms figure for window→canvas in an Electron host was not found; one
  real-world report describes visible input-echo lag from SCK's change-detection missing small
  updates. INFERRED/anecdotal, no number to cite.
- Retina/HiDPI: `SCWindow.frame` is in points; `SCStreamConfiguration.width/height` are pixels —
  you must multiply by the backing scale factor or you capture at half resolution on a 2x display.
  VERIFIED (API shape, from docs/forum search).
- **Electron's existing `desktopCapturer` is a red herring for this.** It is NOT ScreenCaptureKit —
  it's the legacy `CGWindowListCreateImage`-style periodic snapshot path. VERIFIED,
  [Electron desktopCapturer docs](https://www.electronjs.org/docs/latest/api/desktop-capturer).
  It's screenshot-polling, not a live compositor stream, and `getDisplayMedia` in Electron routes
  through the same picker. So "just use Electron's built-in window capture" does not get you a
  ScreenCaptureKit-quality live view — it would need the native SCK path above.
- **Permission — the sharp edge for Operator specifically:** Screen Recording (TCC) is required;
  check with `CGPreflightScreenCaptureAccess()`, prompt with `CGRequestScreenCaptureAccess()`.
  VERIFIED. On current macOS, `CGPreflightScreenCaptureAccess()`/SCK **requires a binary signed
  with a real Developer ID Team — an ad-hoc/unsigned build always reports `false`** regardless of
  what System Settings shows. VERIFIED, [Cap issue #1722](https://github.com/CapSoftware/Cap/issues/1722).
  Operator ships notarized Developer-ID builds already (confirmed in this repo, `@electron/notarize`
  in `electron/package.json`), so this is satisfied — but a rebuild that changes the code signature
  or bundle ID is treated as a new app by TCC and needs re-consent. INFERRED, standard TCC
  behavior, consistent with the cited issue. Worth testing explicitly across an Operator version
  bump, the same way the updater's re-consent story already gets tested per the hub note.
- **iOS Simulator** is just an ordinary macOS window (Simulator.app) — the same SCK per-window
  capture applies to it with no special case. `simctl io <device> screenshot` / `recordVideo` are
  the CLI-native alternative for a static/video capture rather than a live stream.

**Input forwarding (clicks/keys into a window Operator doesn't own):**

- Two real, working paths: `CGEventPostToPid` (synthetic events, needs Accessibility/Input
  Monitoring) and `AXUIElementPerformAction` (AX-level actions, e.g. `AXPress`). VERIFIED, with a
  working reference implementation doing exactly this 3-tier fallback (AX action → synthetic
  CGEvent → pid-targeted event) — [computer-harness](https://github.com/huytieu/computer-harness).
- Known limitation from that same source: **AX-based clicks silently no-op on many
  browser-rendered/custom-drawn views**, Electron/Chromium content included — you fall through to
  raw CGEvent for those. VERIFIED (README of the cited repo).
- Sandbox interaction: event-tap/pid-targeted input control is largely incompatible with App
  Sandbox. VERIFIED pattern, consistent with Apple's sandbox docs (§5). Not a blocker for
  Operator's current unsandboxed packaging.

---

## 2. INSPECT — element boxes, roles, properties

Three distinct mechanisms, and they don't overlap in coverage — this is the section most likely to
need per-app-type branching in code, unlike SHOW.

**(a) macOS Accessibility (AXUIElement) — for SwiftUI/AppKit/Catalyst:**

- `AXUIElementCreateApplication(pid)` + `AXUIElementCopyAttributeValue` walking
  `kAXChildrenAttribute`, reading `kAXPositionAttribute`/`kAXSizeAttribute` (frame) and
  `kAXRoleAttribute`/`kAXTitleAttribute`/`kAXDescriptionAttribute` (role/label) is enough for
  web-inspector-style boxes. VERIFIED, standard AX API shape. Requires the caller to be
  Accessibility-trusted (`AXIsProcessTrustedWithOptions`, which can trigger the system consent
  dialog). A real gotcha from developer accounts (not docs): the trust check can be stale
  in-process, so the *first* AX call right after granting can return `kAXErrorAPIDisabled` with an
  empty tree — worth a retry-after-grant path. [Apple Developer Forums](https://developer.apple.com/forums/thread/121114).
- **Quality varies a lot by framework**, and this is the load-bearing finding for scoping v1:
  - **AppKit**: VERIFIED-by-design — NSView AX conformance is required for VoiceOver, historically
    the most complete tree of the group.
  - **SwiftUI**: VERIFIED gap, not fully characterized — independent reports describe SwiftUI's AX
    tree as coarser than its view tree: list rows, toolbar buttons, subviews inside a composite
    view are sometimes absent or merged into a parent node. SwiftUI builds a *separate*
    accessibility tree, not a mirror of the view tree.
    [createwithswift.com](https://www.createwithswift.com/understanding-the-accessible-user-interface/),
    [GitHub issue](https://github.com/water-rs/apple-backend/issues/100).
  - **Catalyst**: VERIFIED — Apple states UIKit containers become AX nodes structurally aligned
    with AppKit's AX API; UIViews bridge to NSViews at runtime. WWDC20
    ["Accessibility design for Mac Catalyst"](https://developer.apple.com/videos/play/wwdc2020/10117/).
    Likely the best-behaved of the three native cases for this reason.
  - **Electron/Chromium**: VERIFIED — bridges into native AX via an `AXWebArea` node, but builds
    it **lazily**; a cold query can return an unlabeled/empty group until the tree is forced (some
    poking via `AXManualAccessibility` needed). [Electron a11y docs](https://www.electronjs.org/docs/latest/tutorial/accessibility),
    [Chromium a11y overview](https://chromium.googlesource.com/chromium/src/+/main/docs/accessibility/overview.md).
    → For Electron, prefer CDP (below) over AX; it doesn't have this laziness problem and gives a
    richer, purpose-built tree.
  - **Tauri/WKWebView**: INFERRED — WebKit's AX bridge is the same one Safari and years of macOS AX
    tooling rely on; likely more reliably populated than Chromium's lazy tree, but no direct
    comparison source found.
- Existing tooling: Apple's own **Accessibility Inspector.app** (Xcode → Open Developer Tool) is
  the reference implementation and is itself built as a Swift/ObjC helper calling the AX C API
  directly — that's the template for an Operator-side helper, not a Node wrapper (none found).
  VERIFIED tool exists; no canonical Node AX wrapper found.

**(b) Chrome DevTools Protocol — for Electron:**

- `--remote-debugging-port=<port>` (a genuine Chromium switch, distinct from Node's `--inspect` and
  from `ELECTRON_RUN_AS_NODE`) exposes full CDP over HTTP/WebSocket, discoverable at
  `http://localhost:<port>/json`. VERIFIED,
  [Electron command-line-switches docs](https://www.electronjs.org/docs/latest/api/command-line-switches).
  Must be set before `app.ready` (or passed at launch) — cannot attach after the fact without it.
- With it, an Electron renderer is CDP-indistinguishable from any Chrome tab: `DOM.getDocument` /
  `DOM.getBoxModel` for element boxes (same as today's injected-script path, but without needing to
  inject anything), `Overlay.highlightNode` for hover boxes, `Page.captureScreenshot` for frames,
  `Accessibility.getFullAXTree` for a purpose-built AX tree that doesn't have Chromium's lazy-AX
  problem. INFERRED but very high confidence — this is exactly the protocol Chrome DevTools itself
  speaks, and Playwright/Puppeteer already drive Electron apps this way.
- Caveat: each `BrowserWindow`/`WebContentsView`/hidden background page is its own CDP target (own
  `/json` entry) — a multi-window app needs per-target discovery. The main (Node) process is not
  inspectable this way at all, only renderers.
- **This is the best-value INSPECT path in the whole report**: it's strictly *more capable* than
  today's injected-script approach (native `Overlay.highlightNode`/`DOM.getBoxModel` instead of a
  hand-rolled `getBoundingClientRect` overlay script) and needs no native addon, no AX permission,
  no Swift helper — just a launch flag Operator already controls (it owns the spawn path for
  Electron dev servers) and a `chrome-remote-interface`-style WebSocket client in the main process.

**(c) WKWebView remote inspection — for Tauri:**

- `WKWebView.isInspectable` (macOS 13.3+) is real and documented, `false` by default. VERIFIED,
  [Apple docs](https://developer.apple.com/documentation/webkit/wkwebview/isinspectable),
  [WebKit blog](https://webkit.org/blog/13936/enabling-the-inspection-of-web-content-in-apps/).
  Consumed today via a **human clicking Safari's Develop menu** — no public headless/programmatic
  protocol equivalent to CDP's `/json` endpoint was found. VERIFIED (absence).
- Critically: `isInspectable` must be set in the **target app's own Swift/ObjC source**. Operator
  cannot turn this on for an arbitrary Tauri project it doesn't control the source of — it only
  works for a Tauri app the *project* built with it enabled (or with Tauri's dev-mode devtools flag
  on, which Tauri auto-enables in debug builds by convention). This makes Tauri INSPECT
  meaningfully weaker than Electron's: dependent on the target project's own build config, not
  something Operator can force from outside. INFERRED (Tauri devtools-flag default not
  independently re-verified this pass, standard Tauri knowledge).

**(d) iOS Simulator:**

- Prior art exists (`xctree`, `sim-use`) but goes through Facebook's `idb` XCFrameworks + Apple's
  Accessibility APIs + the simulator HID pipeline — i.e. talks to the booted app via an
  XCTest-adjacent private channel, not by AX-querying Simulator.app's own window from outside.
  VERIFIED prior art exists — [sim-use](https://github.com/iXerol/sim-use),
  [xctree writeup](https://ldomaradzki.com/blog/xctree-accessibility-cli) — but no evidence anyone
  gets element boxes by pointing plain `AXUIElement` at the Simulator window itself.
- **Xcode's View Debugger has no public API at all** — Debug View Hierarchy is strictly an
  Xcode-attached-debugger feature (`recursiveDescription()` is a private `UIView` method); this is
  a dead end regardless of app type, distinct from the AX API. VERIFIED (absence),
  [InAppViewDebugger](https://github.com/hhy5277/inappviewdebugger) is what third parties build
  instead — an in-app debugger, not a driver for Xcode's.

**What redlines/grid would need per type:** for Electron via CDP, `DOM.getBoxModel` gives the same
content/padding/border/margin boxes the web overlay already computes from
`getBoundingClientRect`+`getComputedStyle` — a near-drop-in replacement for the measurement math in
`preview-overlay.js`. For AX-based native apps (SwiftUI/AppKit/Catalyst), you only get outer frame
boxes (position+size) — no box-model breakdown (no padding/border/margin from AX), so redlines would
degrade to "distance between two elements' outer frames" rather than the padding-aware
container-relative measurement `containerOf()`/`measureBetween()` do today for web. That's a real,
inherent capability gap, not an implementation gap — AX doesn't expose CSS-box-model concepts because
native UI doesn't have them.

---

## 3. ANNOTATE — pinning a note with enough context for an agent

Today's two modes set the ceiling and floor for what's achievable:

- **Annotate** (cross-origin iframe): can't read the DOM at all, so `annotations.ts` stores
  resolution-independent geometry (`xPct`/`yPct` of the *page*, not the panel — this took a
  migration, `ANNOTATION_GEOM_VERSION`) plus context it *can* observe: full URL, device
  preset/pixel viewport, route. The composed message gives the agent human-legible location hints
  ("top-left", "~12%,34%") rather than a code-level reference.
- **Inspect** (same-origin `WebContentsView`, Operator owns it): the injected script can read the
  real DOM, so it can — per the code's own comments — compute a CSS selector and a
  component/tag#id.class label (`preview-overlay.js:264-269`, `anchorInfo()`), which is strictly
  richer than the Annotate-mode fallback.

For native apps, the achievable context per app type maps directly onto §2's mechanisms, not a new
one:

- **Electron via CDP**: strictly matches today's Inspect mode or better — `DOM.getBoxModel` gives
  exact geometry, and CDP's `DOM.getOuterHTML`/`CSS.getComputedStyleForNode` on the picked node give
  something at least as good as a CSS selector — arguably better, since CDP can hand back real
  DOM/CSS state rather than a hand-computed selector string.
  A screenshot crop (`Page.captureScreenshot` with a clip rect) is free at this point too, giving
  the agent a visual in addition to structure — something neither current mode does today for the
  web case (worth flagging as a polish item for the *existing* web Inspect, not just a native gap).
- **SwiftUI/AppKit/Catalyst via AX**: an AX path string (walking parent `kAXParent` chain, or the
  element's role+index within its `kAXChildrenAttribute` array) is the native equivalent of a CSS
  selector — usable for the agent to reason about "which element" even without seeing source. Frame
  box from AX + a window-region screenshot crop (via the SHOW capture path in §1) is the deliverable
  — no computed-style/box-model breakdown is available (§2 caveat).
- **Tauri (no `isInspectable`) / Simulator (no external AX path)**: degrades to exactly what
  Annotate does today for a cross-origin iframe — percentage geometry + a screenshot crop + a
  human-legible position description, no selector/AX-path at all. This is the honest floor for
  those two cases until something upstream changes (Tauri project opts into `isInspectable`, or a
  Simulator-side XCTest-adjacent bridge is built).

---

## 4. Launch mechanics per app type

- **Electron dev app**: `npm run electron:dev` (or the project's script) with
  `--remote-debugging-port` injected — Operator already owns this launch path for a project's dev
  server (same pattern as today's `PORT`/`OPERATOR_DEV_PORT` env injection in `terminals.ts`), so
  adding one more flag/env var is a small, well-precedented change. Then discover the target via
  `http://localhost:<port>/json`. VERIFIED mechanism, INFERRED integration effort (low).
- **SwiftUI/AppKit native app**: `xcodebuild build` then `open <built>.app` or exec the binary
  directly. Finding "its window" afterward is a window-manager problem
  (`CGWindowListCopyWindowInfo`/`NSWorkspace`), separate from the AX/CDP question — not deeply
  researched this pass, flagged as a follow-up if this path is pursued.
- **iOS Simulator**: `xcrun simctl boot/install/launch` — standard, documented Xcode CLI commands.
  Simulator.app itself is an ordinary macOS window once booted, so §1's SCK capture applies with no
  special case; `simctl io <device> screenshot`/`recordVideo` is the CLI-native fallback for
  static/video capture instead of a live stream.
- **Tauri**: same shape as a generic dev command (`tauri dev` / `npm run tauri dev`), no CDP
  discovery step since there's no equivalent endpoint — attach story is whatever `isInspectable`
  allows (§2c), which may be nothing.
- None of this was tested against a real running app this pass — everything here is "what the
  documented CLI/API surface says," not a working prototype.

---

## 5. Costs: what breaks under Operator's actual packaging

Checked directly against this repo's `electron/build/entitlements.plist`, not inferred: Operator
ships **hardened runtime, no App Sandbox entitlement**. That is the single fact that decides whether
any of this is possible at all:

- **App Sandbox would have killed this entirely.** VERIFIED: sandboxed apps cannot use the
  Accessibility API to control *other* processes — no entitlement unlocks it, which is exactly why
  macOS automation/window-manager tools are distributed outside the Mac App Store.
  [Apple App Sandbox entitlements docs](https://developer.apple.com/documentation/security/app_sandbox_entitlements),
  [Eclectic Light Co.](https://eclecticlight.co/2023/06/24/explainer-the-app-sandbox/),
  [Apple Developer Forums](https://developer.apple.com/forums/thread/810677).
  Operator is not sandboxed, so this does not block it.
- **Screen Recording is purely a TCC grant, independent of sandbox status.** VERIFIED: there is no
  `com.apple.security.screen-capture` entitlement; capture is gated by `kTCCServiceScreenCapture`.
  A separate, narrower, Apple-approval-gated entitlement
  (`com.apple.developer.persistent-content-capture`) exists only to avoid a re-prompt on every
  launch, not to enable capture at all. [Apple Developer Forums](https://developer.apple.com/forums/thread/683860).
  → Operator needs the user to grant Screen Recording once (standard TCC prompt, same class as
  today's other permission prompts the hub note already tracks), and should preflight with
  `CGPreflightScreenCaptureAccess()` before prompting rather than surprising the user.
- **Native helper: Swift sidecar, not a node addon, is the realistic build.** ScreenCaptureKit and
  the AX C API are both Swift/ObjC-first with no maintained Node bindings found anywhere in this
  research. A signed Swift helper binary (invoked the way Operator already invokes other signed
  helpers per its hardened-runtime entitlements comment: *"without this the hardened runtime
  refuses to exec a child that is not signed by us"*) streaming frames/AX data back over a local
  socket is the shape that fits both the API surface and Operator's existing signing model.
- **Re-consent on rebuild is a real, testable risk**, same category as the update-installer
  re-consent issue already tracked for this project (`project_updater_install_teardown.md`,
  `project_tcc_prompt_second_source.md`) — worth explicit verification across an Operator version
  bump before shipping, not assumed safe because it worked once.

---

## Staged recommendation

**Stage 1 — best value, lowest cost, ship first: Electron via CDP.**
No native helper, no new permission, no AX ambiguity. `DOM.getBoxModel`/`Overlay.highlightNode`
give strictly better INSPECT than today's hand-rolled overlay script, for the app type Operator's
own users are most likely to be building (Operator itself is an Electron app; most projects on this
machine per the worktree audit are web dev servers already, and Electron desktop projects are the
adjacent, most-likely-next case). SHOW can start as `Page.captureScreenshot` polling (cheap, no SCK)
before investing in a live stream.

**Stage 2 — SwiftUI/AppKit via AX + SCK, if native macOS app projects show up.** Higher cost (a
signed Swift helper, a new TCC permission flow, AX's coarser/no-box-model ceiling for redlines) but
architecturally clear and not blocked by anything in Operator's current packaging. Do the TCC
preflight/re-consent verification before committing to this stage.

**Stage 3 — Tauri and Simulator, lowest expected value.** Tauri's INSPECT ceiling depends on the
target project opting into `isInspectable` in its own source, which Operator can't force — likely
degrades to Annotate-mode's screenshot+geometry floor most of the time. Simulator has real prior art
(`sim-use`/`xctree`) but through an XCTest-adjacent channel that's a materially different
integration than everything else in this report — worth a dedicated follow-up, not bundled into a
first pass.

**Polish items for the existing web preview, independent of any native work** (comparing §2/§3
above against what `preview-inspect.ts`/`preview-overlay.js` do today):
- Add a screenshot crop to the composed annotation/inspect note. Neither Annotate nor Inspect mode
  attaches a visual today (`annotations.ts` composes text-only context); CDP's
  `Page.captureScreenshot` with a clip rect (or, for the existing web case, `WebContentsView`
  already has full-page capture available) is a cheap addition that every native-app path above
  would need anyway, so the web path might as well get it first and validate the composer changes
  once.
- The CDP `Overlay.highlightNode`/`DOM.getBoxModel` pattern is worth borrowing even for the
  existing web Inspect path — it's the same protocol DevTools itself uses for the "$0" hover
  highlight, and would remove the current tree-walking (`containerOf()` in `preview-overlay.js:88-103`)
  in favor of one CDP call.

---

## Sources

- [SCContentFilter.init(desktopIndependentWindow:)](https://developer.apple.com/documentation/screencapturekit/sccontentfilter/init(desktopindependentwindow:))
- [WWDC22 — Meet ScreenCaptureKit](https://developer.apple.com/videos/play/wwdc2022/10156/)
- [screencapturekit-rs](https://github.com/svtlabs/screencapturekit-rs)
- [Sunshine PR #5511 — native macOS SCK capture](https://github.com/LizardByte/Sunshine/pull/5511)
- [Electron desktopCapturer docs](https://www.electronjs.org/docs/latest/api/desktop-capturer)
- [Cap issue #1722 — CGPreflightScreenCaptureAccess requires real signing](https://github.com/CapSoftware/Cap/issues/1722)
- [computer-harness — CGEvent/AX input forwarding reference](https://github.com/huytieu/computer-harness)
- [Apple Developer Forums — AXIsProcessTrustedWithOptions gotchas](https://developer.apple.com/forums/thread/121114)
- [createwithswift.com — SwiftUI accessibility tree](https://www.createwithswift.com/understanding-the-accessible-user-interface/)
- [GitHub — SwiftUI AX tree gaps](https://github.com/water-rs/apple-backend/issues/100)
- [Electron accessibility docs](https://www.electronjs.org/docs/latest/tutorial/accessibility)
- [Chromium accessibility overview](https://chromium.googlesource.com/chromium/src/+/main/docs/accessibility/overview.md)
- [WWDC20 — Accessibility design for Mac Catalyst](https://developer.apple.com/videos/play/wwdc2020/10117/)
- [sim-use](https://github.com/iXerol/sim-use)
- [xctree writeup](https://ldomaradzki.com/blog/xctree-accessibility-cli)
- [InAppViewDebugger](https://github.com/hhy5277/inappviewdebugger)
- [Electron command-line-switches docs](https://www.electronjs.org/docs/latest/api/command-line-switches)
- [WKWebView.isInspectable](https://developer.apple.com/documentation/webkit/wkwebview/isinspectable)
- [WebKit blog — enabling inspection of web content in apps](https://webkit.org/blog/13936/enabling-the-inspection-of-web-content-in-apps/)
- [Apple App Sandbox entitlements docs](https://developer.apple.com/documentation/security/app_sandbox_entitlements)
- [Eclectic Light Co. — App Sandbox explainer](https://eclecticlight.co/2023/06/24/explainer-the-app-sandbox/)
- [Apple Developer Forums — sandboxed accessibility](https://developer.apple.com/forums/thread/810677)
- [Apple Developer Forums — screen-capture entitlement](https://developer.apple.com/forums/thread/683860)
