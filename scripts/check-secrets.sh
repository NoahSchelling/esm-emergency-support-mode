#!/usr/bin/env bash
# check-secrets.sh - Scan changes that are about to be committed or pushed
# for credentials and personally identifiable information.
#
# Usage:
#   scripts/check-secrets.sh            # same as --staged
#   scripts/check-secrets.sh --staged   # scan the index (git diff --cached)
#   scripts/check-secrets.sh --push     # scan commits not yet on any remote
#   scripts/check-secrets.sh --push <commit>...
#                                       # same, starting from the given commits
#                                       # instead of HEAD (used by pre-push)
#   scripts/check-secrets.sh --range <base> <head>
#                                       # scan commits reachable from <head>
#                                       # but not from <base>, whether or not
#                                       # they are on a remote (used by CI).
#                                       # An all-zero <base> scans everything
#                                       # reachable from <head>.
#
# Exit status:
#   0  no blocking problem found (warnings may still be printed)
#   2  blocking problem found, or the check itself could not run
#
# Only bash and git are required. Every detection pattern below is built by
# string concatenation so that this file never matches its own rules; no file
# is excluded from the scan, including this one.

set -u
export LC_ALL=C

prog="check-secrets"

die() {
  printf '%s: エラー: %s\n' "$prog" "$1" >&2
  exit 2
}

usage() {
  cat >&2 <<'EOF'
Usage: scripts/check-secrets.sh [--staged | --push [<commit>...] | --range <base> <head>]
  --staged  ステージされた変更を検査する（既定）
  --push    まだリモートにないコミットの差分を検査する
            <commit> を渡すと HEAD の代わりにそのコミットから辿る
  --range   <head> から辿れて <base> から辿れないコミットの差分を検査する
            （リモートにあるかどうかは問わない。CI で使う。<base> がすべて 0 なら全履歴）
環境変数 ESM_DENYLIST_FILE: 個人語（禁止語）を 1 行 1 語で書いたファイル（リポジトリ外）
EOF
}

mode="staged"
push_tips=()
case "${1:-}" in
  "" | --staged)
    mode="staged"
    (($# > 1)) && { usage; die "--staged は引数を取りません"; }
    ;;
  --push)
    mode="push"
    shift
    push_tips=("$@")
    ;;
  --range)
    mode="range"
    (($# == 3)) || { usage; die "--range には <base> と <head> の 2 つを渡してください"; }
    range_base="$2"
    range_head="$3"
    ;;
  -h | --help) usage; exit 0 ;;
  *) usage; die "不明な引数: $1" ;;
esac

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || die "git リポジトリの中で実行してください"
cd "$repo_root" || die "リポジトリのルートに移動できません"

# ---------------------------------------------------------------------------
# Detection patterns (assembled from fragments on purpose; see header).
# ---------------------------------------------------------------------------
rule_names=()
rule_regex=()
add_rule() { rule_names+=("$1"); rule_regex+=("$2"); }

add_rule "Anthropic API キー"        'sk''-ant-''[A-Za-z0-9_-]{20,}'
add_rule "AWS アクセスキー ID"       '(AK''IA|AS''IA)''[0-9A-Z]{16}'
add_rule "AWS シークレットアクセスキー" '[Aa][Ww][Ss]_?[Ss][Ee][Cc][Rr][Ee][Tt]''[A-Za-z_]*''["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"']?''[A-Za-z0-9/+=]{40}'
add_rule "GitHub トークン"           'gh''[pousr]_''[A-Za-z0-9]{36,}'
add_rule "GitHub fine-grained トークン" 'github''_pat_''[A-Za-z0-9_]{22,}'
add_rule "秘密鍵の開始行"            '-----''BEGIN ''([A-Z0-9]+ )*''PRIVATE'' KEY'

at="@"
email_re='[A-Za-z0-9._%+-]+'"$at"'[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}'
hx='[0-9A-Fa-f]'
uuid_re="${hx}{8}-${hx}{4}-${hx}{4}-${hx}{4}-${hx}{12}"

# Domains whose addresses are allowed (exact domain or any subdomain of the
# second one). Compared in lower case.
allowed_domain_noreply="users.noreply.github"".com"
allowed_domain_example="example"".com"

# ---------------------------------------------------------------------------
# Personal denylist (ESM_DENYLIST_FILE). Must live outside the repository.
# ---------------------------------------------------------------------------
deny_words=()
deny_lines=()
deny_status=""

load_denylist() {
  local f="${ESM_DENYLIST_FILE:-}"
  if [[ -z "$f" ]]; then
    deny_status="環境変数 ESM_DENYLIST_FILE が未設定"
    return
  fi
  if [[ ! -f "$f" || ! -r "$f" ]]; then
    deny_status="ESM_DENYLIST_FILE が指すファイルが見つからないか読めない"
    return
  fi
  local dir abs top
  if [[ "$f" == */* ]]; then dir="${f%/*}"; else dir="."; fi
  [[ -z "$dir" ]] && dir="/"
  dir=$(cd -- "$dir" 2>/dev/null && pwd -P) || {
    deny_status="ESM_DENYLIST_FILE のディレクトリを解決できない"
    return
  }
  abs="${dir%/}/${f##*/}"
  top=$(pwd -P)
  if [[ "$abs" == "$top/"* ]]; then
    die "禁止語リスト（ESM_DENYLIST_FILE）がリポジトリ内にあります。リポジトリ外へ移動してください"
  fi
  local line n=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    n=$((n + 1))
    line=${line%$'\r'}
    # Trim surrounding whitespace; skip blank lines and '#' comment lines.
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" || "$line" == "#"* ]] && continue
    deny_words+=("${line,,}")
    deny_lines+=("$n")
  done <"$f"
  if ((${#deny_words[@]} == 0)); then
    deny_status="ESM_DENYLIST_FILE に禁止語が 1 つもない"
  fi
}

load_denylist

# ---------------------------------------------------------------------------
# Reporting helpers. Matched values are masked so that the output itself does
# not leak the secret or the personal word.
# ---------------------------------------------------------------------------
errors=0
warnings=0

mask() {
  local s="$1"
  printf '%s****(%d 文字)' "${s:0:2}" "${#s}"
}

report_error() {
  errors=$((errors + 1))
  printf '%s: 停止: %s\n' "$prog" "$1" >&2
}

report_warning() {
  warnings=$((warnings + 1))
  printf '%s: 警告: %s\n' "$prog" "$1" >&2
}

# where = "<commit>:<path>:<line>" or "<path>:<line>"
check_text() {
  local where="$1" text="$2" i m rest domain lower

  for i in "${!rule_regex[@]}"; do
    if [[ "$text" =~ ${rule_regex[$i]} ]]; then
      report_error "$where: ${rule_names[$i]}の可能性 [$(mask "${BASH_REMATCH[0]}")]"
    fi
  done

  rest="$text"
  while [[ "$rest" =~ $email_re ]]; do
    m="${BASH_REMATCH[0]}"
    rest="${rest#*"$m"}"
    domain="${m##*"$at"}"
    domain="${domain,,}"
    if [[ "$domain" == "$allowed_domain_noreply" ||
      "$domain" == "$allowed_domain_example" ||
      "$domain" == *".$allowed_domain_example" ]]; then
      continue
    fi
    report_error "$where: メールアドレス [$(mask "$m")]"
  done

  if [[ "$text" =~ $uuid_re ]]; then
    report_warning "$where: UUID 形式の文字列 [$(mask "${BASH_REMATCH[0]}")]（止めません。公開してよい値か確認してください）"
  fi

  if ((${#deny_words[@]} > 0)); then
    lower="${text,,}"
    for i in "${!deny_words[@]}"; do
      if [[ "$lower" == *"${deny_words[$i]}"* ]]; then
        report_error "$where: 個人語に一致（禁止語リストの ${deny_lines[$i]} 行目）"
      fi
    done
  fi
}

check_path() {
  local where="$1" path="$2" base lbase
  base="${path##*/}"
  lbase="${base,,}"

  case "$base" in
    .env.example) ;;
    .env | .env.*) report_error "$where: コミットしてはいけないファイル（.env 系）: $path" ;;
  esac
  if [[ "$lbase" == *.pem ]]; then
    report_error "$where: コミットしてはいけないファイル（*.pem）: $path"
  fi
  if [[ "$path" == ".claude/settings.local.json" || "$path" == */.claude/settings.local.json ]]; then
    report_error "$where: コミットしてはいけないファイル（個人設定）: $path"
  fi
  if [[ "$base" == "CLAUDE.local.md" ]]; then
    report_error "$where: コミットしてはいけないファイル（個人メモ）: $path"
  fi
  # Personal words must not appear in file names either.
  check_text "$where(ファイル名)" "$path"
}

# ---------------------------------------------------------------------------
# Collect the changes to scan.
# ---------------------------------------------------------------------------
git_q=(git -c core.quotePath=false)

if [[ "$mode" == "staged" ]]; then
  diff_cmd=("${git_q[@]}" diff --cached --no-color --no-ext-diff -U0 -M --diff-filter=ACMR)
  names_cmd=("${git_q[@]}" diff --cached --name-only -M --diff-filter=ACMR)
  scope="ステージされた変更"
else
  revs=()
  if [[ "$mode" == "range" ]]; then
    sha=$(git rev-parse --verify -q "$range_head^{commit}") || die "コミットとして解決できません: $range_head"
    revs=("$sha")
    zero_re='^0+$'
    if [[ ! "$range_base" =~ $zero_re ]]; then
      sha=$(git rev-parse --verify -q "$range_base^{commit}") || die "コミットとして解決できません: $range_base"
      revs+=(--not "$sha")
    fi
    scope="指定範囲のコミット"
  else
    if ((${#push_tips[@]} > 0)); then
      for t in "${push_tips[@]}"; do
        sha=$(git rev-parse --verify -q "$t^{commit}") || die "コミットとして解決できません: $t"
        revs+=("$sha")
      done
      revs+=(--not --remotes)
    elif git rev-parse --verify -q HEAD >/dev/null; then
      revs=(HEAD --not --remotes)
    fi
    scope="リモートにないコミット"
  fi
  diff_cmd=("${git_q[@]}" log --no-color --no-ext-diff -p -U0 -M --diff-merges=first-parent
    --diff-filter=ACMR --format='commit %H' "${revs[@]}")
  names_cmd=("${git_q[@]}" log --format= --name-only -M --diff-merges=first-parent
    --diff-filter=ACMR "${revs[@]}")
fi

if [[ "$mode" == "push" && ${#revs[@]} -eq 0 ]]; then
  diff_out=""
  names_out=""
else
  diff_out=$("${diff_cmd[@]}") || die "差分を取得できません"
  names_out=$("${names_cmd[@]}") || die "ファイル一覧を取得できません"
fi

# File names.
file_count=0
while IFS= read -r p; do
  [[ -z "$p" ]] && continue
  file_count=$((file_count + 1))
  check_path "$p" "$p"
done <<<"$names_out"

# Added lines. Track the commit (push mode), the file, and the new line number.
commit=""
file=""
lineno=0
in_header=0
line_count=0
hunk_re='^@@ -[0-9,]+ \+([0-9]+)'
while IFS= read -r line; do
  case "$line" in
    "commit "*)
      # Only emitted by --format in push mode; diff content lines always
      # carry a one-character prefix, so this cannot be file content.
      commit="${line#commit }"
      commit="${commit:0:8}"
      file=""
      in_header=0
      ;;
    "diff --git "*)
      in_header=1
      file=""
      ;;
    "+++ "*)
      if ((in_header)); then
        p="${line#+++ }"
        if [[ "$p" == "/dev/null" ]]; then file=""; else file="${p#b/}"; fi
      elif [[ -n "$file" ]]; then
        line_count=$((line_count + 1))
        check_text "${commit:+$commit:}$file:$lineno" "${line:1}"
        lineno=$((lineno + 1))
      fi
      ;;
    "@@ "*)
      in_header=0
      if [[ "$line" =~ $hunk_re ]]; then lineno="${BASH_REMATCH[1]}"; fi
      ;;
    "+"*)
      if ((in_header == 0)) && [[ -n "$file" ]]; then
        line_count=$((line_count + 1))
        check_text "${commit:+$commit:}$file:$lineno" "${line:1}"
        lineno=$((lineno + 1))
      fi
      ;;
  esac
done <<<"$diff_out"

# ---------------------------------------------------------------------------
# Summary. The denylist status is always printed when the check did not run.
# ---------------------------------------------------------------------------
if [[ -n "$deny_status" ]]; then
  printf '%s: 注意: 個人語の検査は未実施（%s）\n' "$prog" "$deny_status" >&2
else
  printf '%s: 個人語の検査を実施（禁止語 %d 件）\n' "$prog" "${#deny_words[@]}" >&2
fi

printf '%s: 対象=%s ファイル=%d 追加行=%d 停止=%d 警告=%d\n' \
  "$prog" "$scope" "$file_count" "$line_count" "$errors" "$warnings" >&2

if ((errors > 0)); then
  printf '%s: 問題が見つかったため中止します。該当箇所を修正してから再実行してください。\n' "$prog" >&2
  exit 2
fi
exit 0
