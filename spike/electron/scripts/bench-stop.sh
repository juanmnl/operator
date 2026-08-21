#!/bin/sh
# Stop the arms started by bench-run.sh, by RECORDED PID only.
#
# Never pattern-kill: on this machine `Electron` also matches the user's other apps, and a
# `zsh -il` pattern matches their own shells.
B="$(cd "$(dirname "$0")/.." && pwd)"
M="$B/measurements"
[ -f "$M/pids" ] || { echo "no $M/pids — nothing recorded to stop"; exit 0; }
while read -r pid label; do
  [ -n "$pid" ] || continue
  if kill "$pid" 2>/dev/null; then echo "stopped $label ($pid)"; else echo "$label ($pid) already gone"; fi
done < "$M/pids"
