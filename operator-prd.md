# Operator — PRD
**Mission control for AI coding agents**
Version 0.8 · July 2026

---

## 0. What changed since v0.1

The original concept (an Electron "permission gateway" — an HTTP long‑poll server + floating approval widget + audit log) was **abandoned**. Every part of that model — the gateway, the hook, the notification widget, the auto‑rules engine — is gone. Operator became a different, more useful thing: a **desktop home for running, watching, and steering Claude Code sessions**. This document describes what the app actually is today and where it's going.

---

## 1. Problem

Serious work with a coding agent (Claude Code) happens in a terminal, one session at a time, with no durable home. You lose the thread when the window closes, you can't watch several agents work in parallel without a mess of tabs, the raw TUI is hard to read back, and there's nowhere to keep the plan, the diff, the running app, and the conversation together. Operator gives each repo a persistent cockpit where sessions live, are readable, and can be coordinated.

## 2. Vision

> *"Open a repo. Point agents at it. Watch, read, steer, and ship — all in one place."*

A macOS desktop app that treats each **project (a folder/repo)** as a durable workspace, hosts **many Claude Code sessions** inside it, and renders each session three ways — the live **Console**, a structured **Chat**, and a **Preview** of the running app — with the agent's **Plan** and **Diff** always a click away. Native, fast, transcript‑driven, no agent‑side integration required.

---

## 3. Core concepts

- **Project** — a folder/repo (identified by its canonical git root). The durable home: it owns its sessions over time, its defaults (model/effort/permission), and — coming — its moodboard and context. Sessions come and go; the project persists.
- **Session** — one Claude Code run inside a project, typically isolated in its own **git worktree** so parallel sessions never clobber the working tree. Ephemeral; belongs to a project.
- **Main view** — a session is shown as one of three surfaces, toggled in the toolbar:
  - **Console** — the raw Claude Code TUI (xterm.js + WebGL).
  - **Chat** — a canvas‑rendered, document‑style transcript of the conversation; two‑way (you can send prompts back).
  - **Preview** — the session's running dev app, in an iframe.
- **Right side panel** — the "working" surfaces, contextual to the main view: **Plan** (the agent's todos), **Diff** (working‑tree changes → commit/merge/discard), and **Chat** (when the main view is Console or Preview).
- **Transcript‑driven** — Operator observes Claude Code's own JSONL transcript to build the conversation, plan, activity timeline, and usage. No hook, no gateway, no agent‑side code.

---

## 4. Architecture

Single **Tauri 2** app (Rust backend + React 19 renderer). No Electron, no local HTTP server, no MCP wrapper required.

```
┌──────────────────────────────────────────────┐
│  RENDERER (React 19 + Vite + Tailwind)         │
│  • Sidebar: projects → sessions                │
│  • Main view: Console (xterm) / Chat / Preview │
│  • Right panel: Plan / Diff / Chat             │
│  • Canvas chat renderer + composer             │
└───────────────┬────────────────────────────────┘
                │  window.operator bridge (invoke/events)
                ▼
┌──────────────────────────────────────────────┐
│  BACKEND (Rust / Tauri)                        │
│  • PTY manager: spawn `claude`, resize, I/O    │
│  • Deferred launch (exec at final grid width)  │
│  • Transcript tailer → conversation/plan/usage │
│  • Chat store (SQLite ~/.operator/chat.db)     │
│  • Worktrees, dev-port reservation, tray,      │
│    updater (signed + notarized)                │
└──────────────────────────────────────────────┘
```

- **Terminal:** xterm.js with the **WebGL** renderer (re‑verified clean in current WKWebView; replaced the earlier ghostty‑web engine). Falls back to xterm's DOM renderer on GPU‑context loss.
- **Persistence:** `~/.operator/` — `sessions.json` (durable session snapshot), `chat.db` (SQLite chat history), `img-cache/` (dropped images), `worktrees/`. Session/UI prefs in `localStorage`. **Coming:** `projects.json` + `projects/<id>/` asset dirs.
- **No permission gateway.** Permission mode is Claude Code's own (passed at launch); Operator surfaces it, it doesn't mediate it.

---

## 5. Features (today)

- **Projects & sessions** — sidebar groups sessions by folder/repo; launch a session in a repo, optionally in a git worktree; **fan out** across N parallel agents; durable restore across restarts; resume a prior Claude conversation.
- **Console** — full Claude Code TUI via xterm+WebGL; classic mode with scrollback + wheel; image drop/paste → native `[Image #N]`; OSC‑8 link clicks; deferred launch so the pty opens at the final width (no reflow corruption); self‑heal watchdog.
- **Chat** — canvas‑painted, document‑style conversation (parse‑once markdown incl. tables, task‑lists, strikethrough, code labels, links); search, save/star, dismiss; two‑way composer that sends prompts to the agent; no react‑markdown freeze, no size cap.
- **Preview** — the running dev app in‑window; per‑session dev‑port reservation (IPv4+IPv6 aware) so parallel sessions don't collide.
- **Plan / Diff** — the agent's live todo plan (send your own tasks to the agent); working‑tree diff with commit/merge/discard for worktree sessions.
- **Activity timeline & usage** — every tool call/subagent as it happens; token/cost insights.
- **Consolidated action bar** — one bottom bar: scratch Terminal · Review changes · Activity · working dir.
- **Platform** — animated tray, themes, splash, auto‑update, signed + notarized public releases.

---

## 6. Direction / roadmap

**Foundation (next):** formalize **Project** as a first‑class entity (canonical repo root, `projects.json`, per‑project asset dir + defaults, session linkage, migration, re‑homed sidebar grouping). Everything below hangs off it. *(Design approved — see `~/.claude/plans/`.)*

- **Moodboard** — a project‑scoped image board in the right panel: drop/paste captures + references over time as inspiration; persisted to the project asset dir.
- **Chat overhaul** — a full composer with model / effort / permission selectors, file & context attach, `@`‑mentions, and slash‑command access. (Bounded by what Claude Code exposes; raw‑API control is a separate, larger fork.)
- **Session orchestration** — coordinate many parallel sessions on one project: a project board (all sessions + status/plan/diff), spawn/assign on tasks, review+merge back. Coordination model TBD (parallel fan‑out vs manager→workers vs pipeline).
- **Contextual right panel** — the panel's tab set derives from the main view (Console → Plan/Diff; Chat → sources/outline; Preview → routes/logs).

### 6.1 NOTE — plan later: Preview annotations → Console/Chat feedback loop
A high‑value idea to design: let the user **annotate the Preview** (mark up / point at elements or regions of the running app) and have those annotations **feed back into the Console and/or Chat** as structured context for the agent — e.g. circle a misaligned button in the Preview and it becomes a prompt like "fix this element" with the element's selector/screenshot attached. Closes the visual‑feedback loop (see it running → point at it → agent fixes it) without leaving Operator. Needs a design pass: annotation capture (element picker vs freeform overlay vs screenshot region), what payload the agent receives (selector, DOM snippet, screenshot, description), and which surface it targets (Console paste vs Chat message). *Depends on the Preview + Chat/Console plumbing already in place.*

---

## 7. Tech stack

| Layer | Choice |
|-------|--------|
| Shell | **Tauri 2** (Rust), system WebKit — lean (~15MB) |
| UI | **React 19 + Vite 7 + Tailwind 4** |
| Terminal | **xterm.js + WebGL** (DOM fallback) |
| PTY | `portable_pty` (Rust) |
| Transcript / chat store | JSONL tailer + **SQLite** (`rusqlite`) |
| Git / worktrees | native `git` via the Rust backend |
| Packaging | Tauri build → signed + notarized DMG, auto‑update via a public releases repo |

---

*Historical note: v0.1 of this PRD described an Electron permission‑gateway app that was never the product this became. Kept only as the origin story.*
