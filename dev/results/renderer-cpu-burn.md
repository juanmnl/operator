# Renderer CPU burn — diagnosis (read-only, no code changed)

**Target:** running `/Applications/Operator.app`, `app.asar` built 2026-08-25 08:53, which is
version **0.18.1** at commit `d22538b` ("Release 0.18.1 — the updater can actually update").
Confirmed via the `sample` header (`Version: 0.18.1`) and `git show -s --format=%ci d22538b`
(2026-08-25 08:51:01) — this predates `7f2bdd8`/`7ab5a68` (2026-08-25 15:50/16:05) and is not
an ancestor of either (`git merge-base --is-ancestor d22538b 7ab5a68` fails). Source below is
read at `d22538b` via `git show d22538b:<path>`, not at the `main` tip.

Renderer pid 79528, GPU process pid 79525 (child of the same Operator instance).

## Evidence

**1. Live CPU pattern is sustained, not bursty.** `top -pid 79528 -pid 79525 -l 12 -s 1` over
12 seconds:

```
79525 (GPU)      25.7 → 33.7 → 34.7 → 33.0 → 33.6 → 34.6 → 34.1 → 34.0 → 34.6 → 34.3 → 33.9
79528 (Renderer) 12.7 → 20.9 → 17.6 → 16.6 → 20.3 → 17.0 → 16.9 → 20.9 → 16.8 → 16.8 → 21.7
```

No idle troughs between 1-second samples — this rules out anything on the timer list (all
≥1s intervals: `DashboardView` polls at 4s/5s/30s/3h, `SessionInfoBar`/`AppPreviewPanel` at
4s, `CanvasConversation` at 15s, `App.tsx` heartbeat at 1s, `use-hover-card` measure at 200ms
but only while hovering). A 1s-granularity timer would show visible troughs between ticks;
this doesn't. The GPU process runs consistently *hotter* than the renderer (~33% vs ~18%),
which points at compositing/raster work, not JS logic.

**2. `sample` (1ms interval, 5s) on both processes.** Leaf-of-stack summary
(`Sort by top of stack, same collapsed`) is dominated by blocking syscalls
(`mach_msg2_trap`, `kevent64`, `__workq_kernreturn`, `__psynch_cvwait` — tens of thousands of
samples = threads waiting), which is expected. Function-name symbolication elsewhere is
unreliable — `sample` mis-attributes V8 JIT-generated code addresses to whatever exported
Electron Framework symbol happens to be nearest (visible as nonsense chains like
`ares_dns_rr_get_ttl` → `v8::StackTrace::CurrentStackTrace` → `uv_timer_start` calling each
other), a known limitation of OS-level samplers against V8 JIT code. What *is* reliable
(non-JIT, real native frames) in the GPU process sample:

```
CVDisplayLink::calculateNextWakeUpTime / waitUntil        (in CoreVideo)     — 2 display links firing
-[AGXG16GFamilyRenderContext initWithCommandBuffer:...]   (in AGXMetalG16G_B0) — Metal command encoding
AGX::ContextCommon<...>::newCommand                        (in AGXMetalG16G_B0)
IOGPUMetalResourcePoolCreatePooledResource                 (in IOGPU)
-[CALayer(CALayerPrivate) _copyRenderLayer:...]             (in QuartzCore)
CA::Render::Layer::encode                                   (in QuartzCore)
```

Thread list confirms a live `VizCompositorThread` and **two `CVDisplayLink` threads** in the
GPU process, plus a `Compositor` thread in the renderer — all consistent with continuous,
vsync-paced compositing, not a one-shot repaint.

**3. Source: `StatusWave` renders 37 independently-animated SVG circles per busy lane, and the
keyframe is not compositor-only.**

- `src/renderer/components/sidebar/StatusWave.tsx` (read at `d22538b`): only `running` and
  `compacting` set `animate: true`; every other state (`waiting`, `idle`, `error`, `ended`) is
  static (`cfg.animate === false`). Confirms the "motion is the only busy signal" design intent
  from memory (`project_orb_wake_up_resize`) is intact in this build.
- Dot count: `gridPointsInDisc(CELLS=7, RADIUS=3.4)` (`src/renderer/lib/random.ts`) yields
  **37 points** (hand-verified: for each grid cell, `dx²+dy² ≤ 3.4²·1.04 ≈ 12.02`). Every one
  gets its own `<circle>` with `animation: twinkle …s ease-in-out …s infinite` when the lane is
  busy (`StatusWave.tsx`, the `!cfg.animate` branch is skipped, each dot gets a per-index
  desynced duration/delay).
- The keyframe (`src/renderer/styles.css:695`, read at `d22538b`):
  ```css
  @keyframes twinkle {
    0%, 100% { opacity: 0.3; transform: scale(0.5); fill: var(--tw-fill, var(--fg-muted)); }
    50%      { opacity: var(--tw-max, 0.85); transform: scale(1); fill: var(--tw-fill-peak, var(--fg)); }
  }
  ```
  `opacity` and `transform` are compositor-only properties in Chromium/Blink — those two alone
  could run entirely on the compositor thread with no main-thread or raster cost after the
  first frame. **`fill` is not one of those properties.** Animating an SVG paint property
  forces Blink to invalidate and re-paint the element's layer on every frame the color is
  interpolating, which means: main-thread style recalculation + paint (renderer cost) followed
  by re-rasterization and re-composite (GPU-process cost) — every frame, for as long as the
  animation runs. This is a well-known Chromium rendering-pipeline distinction (compositable
  vs. paint-invalidating animated properties), not specific to this app, but this app's keyframe
  mixes both classes in one animation, which downgrades the whole thing off the compositor fast
  path.
- Why it's *sustained* rather than occasional: per `project_orb_wake_up_resize`
  (memory), any pty byte forces `phase=running` for 1.5s, and this session observed **7 `claude`
  CLI processes actively running** at sample time (`ps aux`: pids 2105, 82314, 80148, 80224,
  83868, 85276, 80395 — Research/Code/Operator lanes across the `operator` and `mantel`
  projects, several with live CPU time accruing). With that many lanes continuously streaming
  pty output, several StatusWave orbs are re-armed into `running`/`compacting` almost back to
  back, so the 37-dot, `fill`-animating keyframe rarely gets a chance to go idle — matching the
  no-troughs CPU trace in (1).

**4. Ruled out with evidence, not just inspection:**
- *Transcript tailer* (`src-tauri/src/transcript.rs`): no polling loop found (grepped for
  `interval`/`poll`); it's event-driven, not a busy-poll — doesn't fit a sustained 60fps-scale
  compositor cost.
- *Terminal resize churn* / xterm DOM reflow: `TerminalPane.tsx`'s `healInterval` and the resize
  paths are not periodic at sub-second granularity; nothing in the renderer's `setInterval`
  list runs faster than 200ms (`use-hover-card`, gated on hover, not global).
- *Inbox announce pass* over `artifacts.db` (320+ rows): `DashboardView.tsx` polls this at 4s
  and 5s — too coarse to produce a trough-free 1-second CPU trace, and reading/paginating SQL
  rows is main-thread/CPU work, not the GPU-heavy Metal/CVDisplayLink pattern actually observed.

## Single biggest cost (my read)

**`StatusWave`'s `twinkle` CSS keyframe animating SVG `fill` alongside `opacity`/`transform`,
multiplied by 37 dots per busy orb and however many lanes are currently `running`/
`compacting`.** This is a continuous, uncapped-duration (`infinite`) animation that cannot run
compositor-only because of the `fill` interpolation, so it costs both renderer (style/paint)
and GPU-process (raster/composite via Metal, paced by the two live `CVDisplayLink`s) CPU for as
long as any lane looks busy — which, with 6-7 lanes actively streaming pty output, is most of
the time. It is the only mechanism found that (a) is driven by rendering, not a JS timer, (b)
scales with the number of active/busy lanes rather than a fixed interval, and (c) matches the
GPU-process-hotter-than-renderer, no-idle-trough shape of the measured trace.

## Not verified (would need a live DevTools/tracing session, not attempted — read-only brief)
- Exact per-frame cost of the `fill` repaint at the current dot count/lane count (would want
  `chrome://tracing` or the Rendering panel's paint flashing, not available headlessly here).
- Whether other palettes/`--tw-fill-peak` values change the repaint cost (color-mix vs. plain
  var lookup) — unlikely to matter much, flagged for completeness only.
