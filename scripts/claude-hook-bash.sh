#!/usr/bin/env bash
# claude-hook-bash.sh - Claude Code PreToolUse hook for the Bash tool.
#
# Reads the hook input JSON from stdin and runs scripts/check-secrets.sh when
# the command contains "git commit" (staged changes) or "git push" (commits
# not yet on a remote). Exit 2 blocks the tool call and shows stderr to
# Claude. On success, any notice from the check (such as "personal word check
# not run") is passed on as JSON so that both the user and Claude can see it.
#
# Only bash and git are used; the JSON is parsed with bash regular expressions.

set -u
export LC_ALL=C

input=$(cat)

# Extract tool_input.command (a JSON string with escapes kept as-is).
cmd_re='"command"[[:space:]]*:[[:space:]]*"(([^"\\]|\\.)*)"'
if [[ ! "$input" =~ $cmd_re ]]; then
  exit 0
fi
cmd="${BASH_REMATCH[1]}"

# Match "git [global options] <sub>" anywhere in the command, including after
# an escaped newline or tab inside the JSON string.
has_git_sub() {
  local sub="$1"
  local re='(^|[^[:alnum:]_./-]|\\[nt])git([[:space:]]+-[^[:space:]]+([[:space:]]+[^-[:space:]][^[:space:]]*)?)*[[:space:]]+'"$sub"'([^[:alnum:]_-]|$)'
  [[ "$cmd" =~ $re ]]
}

modes=()
has_git_sub commit && modes+=(--staged)
has_git_sub push && modes+=(--push)
((${#modes[@]} == 0)) && exit 0

project_dir="${CLAUDE_PROJECT_DIR:-$PWD}"
check="$project_dir/scripts/check-secrets.sh"
if [[ ! -f "$check" ]]; then
  echo "claude-hook-bash: scripts/check-secrets.sh が見つからないため中止します" >&2
  exit 2
fi

notes=""
for m in "${modes[@]}"; do
  out=$(cd "$project_dir" && bash "$check" "$m" 2>&1)
  rc=$?
  if ((rc != 0)); then
    printf '%s\n' "$out" >&2
    # Fail closed: any non-zero status from the check blocks the command.
    exit 2
  fi
  notes+="[$m] $out"$'\n'
done

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

msg=$(json_escape "${notes%$'\n'}")
printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"%s"}}\n' "$msg" "$msg"
exit 0
