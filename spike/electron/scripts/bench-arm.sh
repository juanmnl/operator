#!/bin/sh
# One bench arm, as a launchd-submittable command. Env is baked in here rather than inherited,
# because launchd does not carry the submitting shell's environment.
B="$(cd "$(dirname "$0")/.." && pwd)"
export OPERATOR_ELECTRON_PORT="$2"
export OPERATOR_ELECTRON_PAGE="$3"
export OPERATOR_ELECTRON_CAPTURE="$B/measurements/$1"
export OPERATOR_ELECTRON_CAPTURE_MS="$4"
export OPERATOR_ELECTRON_LABEL="$1"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
exec node "$B/scripts/dev.mjs"
