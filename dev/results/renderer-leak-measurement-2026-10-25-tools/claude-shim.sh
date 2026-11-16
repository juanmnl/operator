#!/bin/zsh
# QA leak-measurement shim. Outside proj-fake it is the real claude.
case "$OPERATOR_LANE_CWD" in *proj-fake*|*leakfake*) ;; *) exec /Users/juanmnl/.local/bin/claude "$@" ;; esac
# Workload lane: which loop is chosen by the lane's directory name suffix (proj-fake-N or worktree dir).
N=${OPERATOR_ROLE_ID:-x}
if [ "$N" = "qa" ]; then
  # long lines + ANSI colour
  i=0
  while true; do
    i=$((i+1))
    printf '\033[1;3%dmline %d \033[0m' $((i%7+1)) $i
    printf '\033[38;5;%dm%s\033[0m\n' $((i%200+17)) "$(head -c 700 /dev/zero | tr '\0' 'x')"
    [ $((i%20)) -eq 0 ] && printf '\033[4;32m%s\033[0m\n' "$(head -c 6000 /dev/zero | tr '\0' 'y')"
    sleep 2
  done
else
  while true; do date; ls -la /usr/bin | head -40; sleep 3; done
fi
