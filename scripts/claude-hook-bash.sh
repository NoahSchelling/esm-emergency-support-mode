#!/usr/bin/env bash
# claude-hook-bash.sh - Claude Code PreToolUse hook for the Bash tool.
#
# Reads the hook input JSON from stdin and:
#   1. blocks commands that would switch the Git hooks off (--no-verify,
#      "commit -n", anything touching core.hooksPath), so that a command such
#      as "git add x && git commit --no-verify" cannot skip both layers;
#   2. for commands that mention "commit" or "push" anywhere, checks that the
#      Git hooks are enabled and executable, then runs scripts/check-secrets.sh
#      (--staged for commit, --push for push). Matching on the bare words is
#      deliberately broad: this hook is a helper layer, and the Git hooks and
#      CI are the layers that must not be bypassed.
# Exit 2 blocks the tool call and shows stderr to Claude. On success, any
# notice from the check (such as "personal word check not run") is passed on
# as JSON so that both the user and Claude can see it.
#
# Only bash and git are used; the JSON is parsed with bash regular expressions.

set -u
set -f
export LC_ALL=C

input=$(cat)

# Extract tool_input.command (a JSON string with escapes kept as-is).
cmd_re='"command"[[:space:]]*:[[:space:]]*"(([^"\\]|\\.)*)"'
if [[ ! "$input" =~ $cmd_re ]]; then
  exit 0
fi
cmd="${BASH_REMATCH[1]}"
lc="${cmd,,}"

block() {
  printf 'claude-hook-bash: 停止: %s\n' "$1" >&2
  exit 2
}

# ---------------------------------------------------------------------------
# 1. Never switch the Git hooks off.
# ---------------------------------------------------------------------------
if [[ "$lc" == *--no-verify* ]]; then
  block "Git のフックを外す指定（--no-verify）を含むコマンドは実行しません。検査が誤検出なら、内容か検査スクリプトを直してください（CLAUDE.md）"
fi
# The one allowed use: setting the hooks path back to .githooks.
set_hooks_re='^[[:space:]]*git([[:space:]]+-c[[:space:]]+[^[:space:]]+|[[:space:]]+-C[[:space:]]+[^[:space:]]+)*[[:space:]]+config([[:space:]]+--local)?[[:space:]]+core\.hookspath[[:space:]]+\.githooks[[:space:]]*$'
if [[ "$lc" == *hookspath* && ! "$lc" =~ $set_hooks_re ]]; then
  block "Git のフックの場所（core.hooksPath）に触れるコマンドは実行しません（読み取りも含む）。許されるのは、.githooks に設定し直すコマンドだけです"
fi
# "git commit -n" is the short form of --no-verify.
commit_n_re='(^|[^[:alnum:]_.-])git([[:space:]]+[^;&|[:space:]\\]+)*[[:space:]]+commit([[:space:]]+[^;&|\\]*)?[[:space:]]-[a-z]*n[a-z]*([[:space:]]|$)'
if [[ "$lc" =~ $commit_n_re ]]; then
  block "git commit の -n（--no-verify と同じ）を含むコマンドは実行しません。メッセージの中の文字に反応した誤検出なら、-F でファイルから渡してください"
fi

# ---------------------------------------------------------------------------
# 2. Scan before commit and push.
# ---------------------------------------------------------------------------
modes=()
[[ "$lc" == *commit* ]] && modes+=(--staged)
[[ "$lc" == *push* ]] && modes+=(--push)
((${#modes[@]} == 0)) && exit 0

project_dir="${CLAUDE_PROJECT_DIR:-$PWD}"
check="$project_dir/scripts/check-secrets.sh"
if [[ ! -f "$check" ]]; then
  block "scripts/check-secrets.sh が見つからないため中止します"
fi

# The Git hooks are the layer that sees what the command really does; refuse
# to go on when they are not active.
hp=$(git -C "$project_dir" config --get core.hooksPath 2>/dev/null)
if [[ "$hp" != ".githooks" && "$hp" != "$project_dir/.githooks" ]]; then
  block "Git のフックが有効になっていません（core.hooksPath が .githooks ではありません）。git config core.hooksPath .githooks を実行してから、やり直してください"
fi
for h in pre-commit commit-msg pre-push; do
  if [[ ! -f "$project_dir/.githooks/$h" || ! -x "$project_dir/.githooks/$h" ]]; then
    block "Git のフック .githooks/$h がないか、実行権限がありません。Git が無視するので、chmod +x で直してから、やり直してください"
  fi
done

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
