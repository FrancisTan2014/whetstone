#!/usr/bin/env bash
# Block any git push by agents. Only the human pushes per AGENTS.md.
# Hook reads the tool input from stdin as JSON; checks if command is a git push.

set -euo pipefail

input="$(cat)"
command="$(echo "$input" | jq -r '.tool_input.command // empty')"

if [[ -z "$command" ]]; then
  exit 0
fi

# Match: git push, git push origin main, git push --force, etc.
if echo "$command" | grep -qE '(^|[^[:alnum:]])git[[:space:]]+push([[:space:]]|$)'; then
  echo "BLOCKED: Agents do not push to remote per AGENTS.md. The human runs 'git push'." >&2
  exit 2
fi

exit 0
