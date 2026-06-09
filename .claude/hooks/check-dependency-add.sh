#!/usr/bin/env bash
# Block dependency additions without approved-deps allowlist.
# Reads tool input from stdin; checks for package-add commands; rejects if pkg not in allowlist.

set -euo pipefail

input="$(cat)"
command="$(echo "$input" | jq -r '.tool_input.command // empty')"

if [[ -z "$command" ]]; then
  exit 0
fi

# Detect package-add commands across stacks.
patterns=(
  'dotnet[[:space:]]+add[[:space:]]+package'
  'dotnet[[:space:]]+add[[:space:]]+reference'
  'npm[[:space:]]+install'
  'npm[[:space:]]+i[[:space:]]'
  'yarn[[:space:]]+add'
  'pnpm[[:space:]]+add'
  'pip[[:space:]]+install'
  'uv[[:space:]]+add'
)

is_dep_add=false
for pat in "${patterns[@]}"; do
  if echo "$command" | grep -qE "$pat"; then
    is_dep_add=true
    break
  fi
done

if [[ "$is_dep_add" == "false" ]]; then
  exit 0
fi

approved_file=".claude/approved-deps.txt"
if [[ ! -f "$approved_file" ]]; then
  echo "BLOCKED: dependency-add commands require .claude/approved-deps.txt; file does not exist." >&2
  echo "Add the dependency name (one per line) to .claude/approved-deps.txt and have a human commit the change first." >&2
  exit 2
fi

# Try to extract the package name(s) from the command. Crude but effective for common shapes:
#   dotnet add package <Name>
#   npm install <name>
#   pip install <name>
pkg=""
if echo "$command" | grep -qE 'dotnet[[:space:]]+add[[:space:]]+package[[:space:]]+'; then
  pkg=$(echo "$command" | sed -E 's/.*dotnet[[:space:]]+add[[:space:]]+package[[:space:]]+([^[:space:]]+).*/\1/')
elif echo "$command" | grep -qE '(npm|yarn|pnpm)[[:space:]]+(add|install|i)[[:space:]]+'; then
  pkg=$(echo "$command" | sed -E 's/.*(npm|yarn|pnpm)[[:space:]]+(add|install|i)[[:space:]]+([^[:space:]]+).*/\3/')
elif echo "$command" | grep -qE '(pip|uv)[[:space:]]+(install|add)[[:space:]]+'; then
  pkg=$(echo "$command" | sed -E 's/.*(pip|uv)[[:space:]]+(install|add)[[:space:]]+([^[:space:]]+).*/\3/')
fi

if [[ -z "$pkg" ]]; then
  echo "BLOCKED: dependency-add command detected; cannot extract package name. Manual review required." >&2
  echo "Command: $command" >&2
  exit 2
fi

# Case-insensitive exact-line match against allowlist.
if grep -qiE "^${pkg}\$" "$approved_file"; then
  exit 0
fi

echo "BLOCKED: package '$pkg' is not in .claude/approved-deps.txt." >&2
echo "Add it (one entry per line) and have a human commit the change, then retry." >&2
exit 2
