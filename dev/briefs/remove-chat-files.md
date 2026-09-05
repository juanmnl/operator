# Brief: remove the Chat and Files views (Code lane) — 2026-09-05

Direction: Juan does not use Chat or Files. Remove both from BOTH shells (Electron is the shipping
app, 0.20.0; Tauri stays compiling). Source of truth for the dependency map:
`dev/results/simplify-audit.md` part 1 — follow it, it lists what must SURVIVE.

Scope
- Delete: CanvasConversation.tsx, ChatComposer.tsx, lib/chat-turns.ts, lib/canvas-md.ts,
  lib/tool-blocks.ts, lib/tool-file-link.ts, components/files/* (FilesView, FilesPanel, FileTree,
  FileViewer, cm-theme.ts), lib/code-nav.ts, and their co-located tests.
- Surgical edits: DashboardView.tsx (MainView/PanelTab unions, ⌘J toggleChat, filesNav state,
  palette entries, render blocks), CanvasPanel.tsx, SessionToolbar.tsx (segmented becomes
  Console · Preview), pane-visibility.ts, chrome.test.ts rows, shared/types.ts (drop TreeEntry,
  FileContent only), env.d.ts + operator-bridge.ts (fileTree, fileRead, chatHistory, imageDataUrl).
- Electron main: remove files.ts and its ipc.ts wiring, chatHistory/imageDataUrl handlers.
  Tauri: chat_history + image_data_url commands and ChatStore::load; keep chatstore write path,
  replies(), chat_db_file.
- Keep: chat-signal.ts (toolVerb + chatSignal used by TaskBoard and the quit guard),
  transcript.rs / transcript.ts, NarrationEntry/ToolBlock/AgentSession.messages/queued,
  ProjectReply + CommsLog, drop-guard.ts (comment edit only).
- ⌘J: unbind (do not reassign). Remove the Chat/Files command-palette entries.
- Do not touch the Diff, Plan, Preview, Comms log, TaskBoard, or roster.
- Preview's file-open links that pointed into Files (code-nav hrefs): make them no-ops or open
  in the terminal's `$EDITOR`? No — just drop the link affordance.

Done means: `npm test` + `cd electron && npm test` + `tsc` + `npm run build` all green, with the
removed tests deleted not skipped; a short `dev/results/remove-chat-files.md` listing files
removed, LOC delta, and every surviving reference to "chat"/"files" you deliberately kept, and
call `mcp__operator__report`. Commit on your branch; do not merge.
