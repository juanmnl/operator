#!/bin/bash
# Operator hook for Claude Code
# Sends tool calls to the Operator widget for approval
# Reads tool call JSON from stdin, posts to Operator, returns decision

OPERATOR_URL="http://127.0.0.1:47821"

# Check if Operator is running
if ! curl -s --max-time 1 "$OPERATOR_URL/health" > /dev/null 2>&1; then
  # Operator not running — allow through silently
  echo '{"decision":"approve"}'
  exit 0
fi

# Read tool call info from stdin
INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')
# Build a human-readable message from the tool input
TOOL_INPUT=$(echo "$INPUT" | jq -r '.tool_input // {} | to_entries | map("\(.key): \(.value | tostring | .[0:120])") | join(", ")')

# Skip sending read-only / low-risk tools to avoid noise
case "$TOOL_NAME" in
  Read|Glob|Grep|Skill|ToolSearch|LSP)
    echo '{"decision":"approve"}'
    exit 0
    ;;
esac

# Determine severity
SEVERITY="medium"
case "$TOOL_NAME" in
  Bash) SEVERITY="high" ;;
  Write) SEVERITY="high" ;;
  Edit) SEVERITY="medium" ;;
esac

# Get working directory
WD=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.command // empty' | xargs dirname 2>/dev/null || echo "$PWD")

RESPONSE=$(curl -s --max-time 120 -X POST "$OPERATOR_URL/request" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg agent "claude-code" \
    --arg action "$TOOL_NAME" \
    --arg message "$TOOL_NAME: $TOOL_INPUT" \
    --arg wd "$PWD" \
    --arg severity "$SEVERITY" \
    '{
      agentId: $agent,
      action: $action,
      message: $message,
      context: { workingDirectory: $wd },
      severity: $severity,
      expiresIn: 120
    }'
  )")

APPROVED=$(echo "$RESPONSE" | jq -r '.approved')

if [ "$APPROVED" = "true" ]; then
  echo '{"decision":"approve"}'
  exit 0
else
  echo '{"decision":"block","reason":"Denied by Operator"}'
  exit 0
fi
