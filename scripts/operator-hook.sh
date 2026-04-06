#!/bin/bash
# Operator hook for Claude Code
# Unified handler for all hook event types
# Forwards events to the Operator gateway for session tracking and permission handling

OPERATOR_URL="http://127.0.0.1:47821"

# Check if Operator is running
if ! curl -s --max-time 1 "$OPERATOR_URL/health" > /dev/null 2>&1; then
  exit 0
fi

# Read event JSON from stdin
INPUT=$(cat)

# Inject hook_event_name, terminal_id, and terminal app
# Claude Code provides event name via CLAUDE_HOOK_EVENT_NAME env var or in the JSON payload as hook_event_name
EVENT_NAME="${CLAUDE_HOOK_EVENT_NAME:-}"
# Fallback: read event name from JSON input if env var is empty
if [ -z "$EVENT_NAME" ]; then
  EVENT_NAME=$(echo "$INPUT" | jq -r '.hook_event_name // .event // "unknown"')
fi
TERMINAL_ID="${OPERATOR_TERMINAL_ID:-}"
TERM_APP="${TERM_PROGRAM:-}"
PAYLOAD=$(echo "$INPUT" | jq --arg event "$EVENT_NAME" --arg tid "$TERMINAL_ID" --arg tapp "$TERM_APP" \
  '. + {hook_event_name: $event} + (if $tid != "" then {terminal_id: $tid} else {} end) + (if $tapp != "" then {term_program: $tapp} else {} end)')

case "$EVENT_NAME" in
  PreToolUse)
    TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')

    # Skip read-only tools
    case "$TOOL_NAME" in
      Read|Glob|Grep|Skill|ToolSearch|LSP)
        # Still forward for session tracking, but non-blocking
        curl -s --max-time 2 -X POST "$OPERATOR_URL/hook" \
          -H "Content-Type: application/json" \
          -d "$PAYLOAD" > /dev/null 2>&1 &
        exit 0
        ;;
    esac

    # Blocking: wait for permission decision
    RESPONSE=$(curl -s --max-time 300 -X POST "$OPERATOR_URL/hook" \
      -H "Content-Type: application/json" \
      -d "$PAYLOAD")

    DECISION=$(echo "$RESPONSE" | jq -r '.decision // "approve"')
    if [ "$DECISION" = "deny" ] || [ "$DECISION" = "block" ]; then
      echo '{"decision":"block","reason":"Denied by Operator"}'
      exit 0
    fi
    echo '{"decision":"approve"}'
    exit 0
    ;;

  SessionStart|SessionEnd|Stop|UserPromptSubmit|PreCompact|TaskCompleted|SubagentStart|SubagentStop)
    # Critical state events: foreground curl guarantees delivery
    curl -s --max-time 5 -X POST "$OPERATOR_URL/hook" \
      -H "Content-Type: application/json" \
      -d "$PAYLOAD" > /dev/null 2>&1
    exit 0
    ;;

  Notification|PostToolUse|PostToolUseFailure)
    # Informational: fire-and-forget is acceptable
    curl -s --max-time 2 -X POST "$OPERATOR_URL/hook" \
      -H "Content-Type: application/json" \
      -d "$PAYLOAD" > /dev/null 2>&1 &
    exit 0
    ;;

  *)
    # Unknown event type — forward non-blocking
    curl -s --max-time 2 -X POST "$OPERATOR_URL/hook" \
      -H "Content-Type: application/json" \
      -d "$PAYLOAD" > /dev/null 2>&1 &
    exit 0
    ;;
esac
