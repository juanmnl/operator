#!/bin/zsh
# live claude CLIs of the QA test lanes, by session id
ps -eo pid,etime,args | grep -E "[c]laude --settings" | grep "scratchpad/x/opdir" | sed -E 's#.*sessions/([0-9a-f]{8})[0-9a-f-]*/settings.json.*#\1#' | paste -sd' ' -
