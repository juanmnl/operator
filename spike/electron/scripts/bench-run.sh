#!/bin/sh
# Start the three measurement arms DETACHED, and write their pids to measurements/pids.
#
# Detached on purpose: a long run is worth nothing if it is reaped at minute 20, and these
# outlive the shell that starts them. `scripts/bench-stop.sh` is the matching teardown — there
# is no pattern-kill anywhere in either script; both act on recorded pids only.
set -e
B="$(cd "$(dirname "$0")/.." && pwd)"
M="$B/measurements"
mkdir -p "$M"
: > "$M/pids"

arm() { # label port page capture_ms
  OPERATOR_ELECTRON_PORT="$2" \
  OPERATOR_ELECTRON_PAGE="$3" \
  OPERATOR_ELECTRON_CAPTURE="$M/$1" \
  OPERATOR_ELECTRON_CAPTURE_MS="$4" \
  OPERATOR_ELECTRON_LABEL="$1" \
  nohup node "$B/scripts/dev.mjs" > "$M/$1.log" 2>&1 < /dev/null &
  echo "$! $1" >> "$M/pids"
}

arm m1-webgl  1450 'bench.html?renderer=webgl&lanes=1&stream=1'                  900000
arm m1-dom    1451 'bench.html?renderer=dom&lanes=1&stream=1'                    900000
arm m2-fleet  1453 'bench.html?renderer=dom&lanes=27&stream=2&fill=1&dwell=15000' 1800000

cat "$M/pids"
