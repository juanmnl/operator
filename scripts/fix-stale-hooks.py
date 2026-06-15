#!/usr/bin/env python3
"""Remove orphaned Claude Code hook entries whose script no longer exists.

Operator's old packaged Electron build registered a hook pointing into
`release/mac-arm64/Operator.app/...`. That dir was removed, so the hook now
errors on every tool call. This strips any hook whose absolute command path is
missing and keeps the valid ones (e.g. scripts/operator-hook.sh).

A backup is written to ~/.claude/settings.json.bak before saving.
"""
import json
import os
import shutil

path = os.path.expanduser("~/.claude/settings.json")
shutil.copy(path, path + ".bak")

data = json.load(open(path))
hooks = data.get("hooks", {})
removed = 0

for event, entries in list(hooks.items()):
    for entry in entries:
        kept = []
        for h in entry.get("hooks", []):
            cmd = h.get("command", "")
            script = cmd.split()[0] if cmd else ""
            if script.startswith("/") and not os.path.exists(script):
                removed += 1
            else:
                kept.append(h)
        entry["hooks"] = kept
    # drop matcher entries (and whole events) left empty
    hooks[event] = [e for e in entries if e.get("hooks")]
    if not hooks[event]:
        del hooks[event]

json.dump(data, open(path, "w"), indent=2)
print(f"Removed {removed} orphaned hook entries. Backup: {path}.bak")
