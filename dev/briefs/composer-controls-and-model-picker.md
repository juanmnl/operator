# Brief — the composer's controls, and how you choose a model

**Lane: Design.** Write your result to `dev/briefs/composer-controls-and-model-picker-RESULT.md`.

Prompted by `zeronsh/comet` (Rust, MIT). Its composer solves two things ours doesn't. Take the
patterns, not the architecture — they drive Claude Code over stream-json and we drive a pty, which
changes what is knowable. That difference is the whole brief.

## What comet does

From its `ARCHITECTURE.md`, verbatim where quoted:

- **A `Send → Steer → Stop` morphing button** — one control whose function follows the run state.
- **Auto-sizing input**, "auto-flip by measured text width" between compact and expanded (76–260px).
- **Drafts and attachments per chat**, drag-drop/paste images.
- **A `QuestionPanel` that DISPLACES the composer** when the agent asks something — "paged, 1-9
  keys, 220ms auto-advance". Not a modal over the chat; it takes the composer's place.
- **Pickers as popovers** — "harness/model, traits, repo w/ folder browser, branch w/ worktree
  toggle" — chosen per session, at creation, from a catalog baked into app state.

## Split this into what we can build now and what we cannot

**BUILDABLE TODAY, on the pty, no new plumbing:**

1. **Send → Steer → Stop.** This is the one I most want. We have a recorded defect that a running
   lane *looks idle in chat, with no interrupt anywhere* — the user cannot tell a working lane from
   a finished one, and cannot stop it without going to the terminal. We already derive run state
   for the StatusWave orbs (running / compacting / waiting / idle), so the state exists; nothing
   in the composer uses it. Stop maps to the same interrupt the terminal sends.
   Mind the house rule: **two verbs must never share a glyph.** A button that is Send in one state
   and Stop in another is exactly that hazard — argue how you keep it unmistakable (label change,
   not icon-only; a deliberate shape change; whatever you defend). Motion is our busy signal and
   only running/compacting animate — do not add a second, competing busy language.
2. **Per-chat drafts.** Cheap, and we lose composer text on every switch today.
3. **The model/effort picker as a popover.** We already decided economy-as-config — a Model +
   Effort + Verbosity pill, explicitly NOT a cost display, with the per-model $/Mtok hint hidden.
   Design where those pills live relative to the composer and what the popover looks like. There is
   a real `PopMenu` with a dismissal contract now (`lib/use-dismiss`) — use it, do not hand-roll.

**GATED — do not design against an assumption here:**

4. **The QuestionPanel.** It depends on the agent telling us it asked a question. Over stream-json
   comet gets that as a typed `requestInput` event. Over a pty we would be scraping a TUI for it.
   Research is answering exactly this in `dev/briefs/stream-json-alongside-pty.md`. Sketch the
   panel if you like, but mark it clearly as blocked on that answer and do not build it.

## Two cautions

- **The baked catalog is the part NOT to copy.** comet bakes model and reasoning catalogs into app
  state. Our own note on model-tier freshness says aliases auto-update on their own, and the real
  gap is a NEW tier appearing that no hardcoded list knows about. Whatever you design must degrade
  to a free-typed model id, or it goes stale the week a new model ships.
- **This is not a multi-provider brief.** Multi-provider stays deferred — it is at odds with
  hosting Claude Code's own CLI. Design the selector so a provider axis *could* exist later without
  a redesign, but do not add one and do not assume it is coming.

## Done means

`dev/briefs/composer-controls-and-model-picker-RESULT.md` with: the Send/Steer/Stop treatment and
how it stays unambiguous; where the model/effort/verbosity pills sit and what the popover is; the
draft behaviour; and a clear statement of what you deliberately left blocked on Research.
