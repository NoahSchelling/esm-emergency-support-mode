#!/usr/bin/env bash
# check-secrets.sh - Scan what is about to be committed, pushed or published
# for credentials and personally identifiable information.
#
# Usage:
#   scripts/check-secrets.sh [--staged]
#       The index (git diff --cached). Default. Used by pre-commit.
#   scripts/check-secrets.sh --message <file>
#       A commit message file and the author/committer identity of the
#       commit being made. Used by commit-msg.
#   scripts/check-secrets.sh --push [--remote <name> | --no-remotes]
#                            [--base <commit>]... [--ref <refname>]...
#                            [<object>...]
#       Commits reachable from <object>... (default HEAD) that are not on the
#       remote. Excluded are the remote-tracking refs of <name> (of every
#       remote when neither --remote nor --no-remotes is given) and every
#       --base. Annotated tags among <object> are scanned too. Used by
#       pre-push.
#   scripts/check-secrets.sh --range <base> <head> [--ref <refname>]...
#       Commits reachable from <head> but not from <base>, whether or not
#       they are on a remote (used by CI). An all-zero <base> scans
#       everything reachable from <head>.
#   scripts/check-secrets.sh --all
#       Every commit, ref name and annotated tag in the repository. Meant for
#       the final check before the repository is made public.
#   --require-denylist (any mode)
#       Fail when the personal-word check cannot run.
#
# For commits (--push, --range, --all) the scan covers the added lines of
# each commit (merges against their first parent), file names, the commit
# message, the author and committer, the given ref names and annotated tags.
#
# Exit status:
#   0  no blocking problem found (warnings may still be printed)
#   2  blocking problem found, or the check itself could not run
#
# Requires bash 4.4+ and git. python3, when present, adds the checks that
# bash cannot do well (Unicode normalisation and legacy encodings for the
# personal words, base64/hex decoding); when it is missing, a notice says so.
# Every detection pattern below is built by string concatenation so that this
# file never matches its own rules; no file is excluded from the scan,
# including this one.

# Old bash (macOS ships 3.2) cannot run this script: stop with a reason
# instead of failing half-way. Written so that bash 3.2 can still parse it.
if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ] ||
  { [ "${BASH_VERSINFO[0]}" -eq 4 ] && [ "${BASH_VERSINFO[1]}" -lt 4 ]; }; then
  printf 'check-secrets: エラー: bash 4.4 以上が必要です（この bash は %s）。macOS では Homebrew などで新しい bash を入れてください\n' "${BASH_VERSION:-不明}" >&2
  exit 2
fi

set -u
# No pathname expansion anywhere: unquoted patterns below are matched against
# text, never against the file system.
set -f
export LC_ALL=C

prog="check-secrets"

die() {
  printf '%s: エラー: %s\n' "$prog" "$1" >&2
  exit 2
}

usage() {
  cat >&2 <<'EOF'
Usage: scripts/check-secrets.sh [--staged | --message <file> | --push [...] | --range <base> <head> | --all] [--require-denylist]
  --staged   ステージされた変更を検査する（既定。pre-commit が使う）
  --message  コミットメッセージのファイルと、作成者・コミッターを検査する（commit-msg が使う）
  --push     まだリモートにないコミットを検査する（pre-push が使う）
             [--remote <名前> | --no-remotes] [--base <コミット>]... [--ref <参照名>]... [<コミットやタグ>...]
  --range    <head> から辿れて <base> から辿れないコミットを検査する
             （リモートにあるかは問わない。CI が使う。<base> がすべて 0 なら全履歴）[--ref <参照名>]...
  --all      すべての参照から辿れる全履歴・参照名・注釈付きタグを検査する（公開前の最終確認）
  --require-denylist  個人語の検査ができないときは止める
環境変数 ESM_DENYLIST_FILE: 個人語（禁止語）を 1 行 1 語で書いたファイル（リポジトリ外）
EOF
}

# ---------------------------------------------------------------------------
# Arguments.
# ---------------------------------------------------------------------------
mode=""
set_mode() {
  [[ -n "$mode" ]] && { usage; die "モードは 1 つだけ指定してください"; }
  mode="$1"
}
require_deny=0
push_tips=()
push_bases=()
ref_args=()
push_remote=""
push_remote_set=0
no_remotes=0
msg_file=""
range_base=""
range_head=""
push_only_used=0

while (($# > 0)); do
  case "$1" in
    --staged) set_mode staged ;;
    --push) set_mode push ;;
    --all) set_mode all ;;
    --range)
      set_mode range
      (($# >= 3)) || { usage; die "--range には <base> と <head> の 2 つを渡してください"; }
      range_base="$2"
      range_head="$3"
      shift 2
      ;;
    --message)
      set_mode message
      (($# >= 2)) || { usage; die "--message にはファイルを渡してください"; }
      msg_file="$2"
      shift
      ;;
    --remote)
      (($# >= 2)) || { usage; die "--remote にはリモートの名前を渡してください"; }
      push_remote="$2"
      push_remote_set=1
      push_only_used=1
      shift
      ;;
    --no-remotes) no_remotes=1 push_only_used=1 ;;
    --base)
      (($# >= 2)) || { usage; die "--base にはコミットを渡してください"; }
      push_bases+=("$2")
      push_only_used=1
      shift
      ;;
    --ref)
      (($# >= 2)) || { usage; die "--ref には参照名を渡してください"; }
      ref_args+=("$2")
      shift
      ;;
    --require-denylist) require_deny=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      usage
      die "不明な引数: $1"
      ;;
    *)
      [[ "$mode" == "push" ]] || { usage; die "不明な引数: $1"; }
      push_tips+=("$1")
      ;;
  esac
  shift
done
[[ -z "$mode" ]] && mode="staged"
if ((push_only_used)) && [[ "$mode" != "push" ]]; then
  usage
  die "--remote・--no-remotes・--base は --push と一緒に使ってください"
fi
if ((${#ref_args[@]} > 0)) && [[ "$mode" != "push" && "$mode" != "range" ]]; then
  usage
  die "--ref は --push か --range と一緒に使ってください"
fi
if ((push_remote_set && no_remotes)); then
  usage
  die "--remote と --no-remotes は同時に使えません"
fi
if [[ "$mode" == "message" && "$msg_file" != /* ]]; then
  msg_file="$PWD/$msg_file"
fi

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || die "git リポジトリの中で実行してください"
cd "$repo_root" || die "リポジトリのルートに移動できません"

notes=()
note() { notes+=("$1"); }

# Settings that could hide content from the scan are pinned for every git
# call (replace refs, attributes from outside the repository, diff prefixes,
# root commits, signatures in the log output).
git_q=(git --no-replace-objects
  -c core.quotePath=false
  -c core.attributesFile=/dev/null
  -c log.showRoot=true
  -c log.showSignature=false
  -c diff.noprefix=false
  -c diff.mnemonicPrefix=false
  -c diff.relative=false)

if [[ -n "${GIT_CONFIG_PARAMETERS:-}${GIT_CONFIG_COUNT:-}" ]]; then
  note "環境変数（git -c など）で Git の設定が足されています。検査に関わる設定は固定していますが、意図した設定か確かめてください"
fi

# ---------------------------------------------------------------------------
# Detection patterns (assembled from fragments on purpose; see header).
#   rule_ci     1 = match against the lower-cased text
#   rule_need   space-separated glob patterns, matched against the lower-cased
#               text; one of them must match before the regular expression
#               runs (a cheap pre-filter)
#   rule_group  capture group holding the value: placeholders such as
#               "example" or "xxxx" are then allowed, and only the value is
#               measured in the report
#   rule_digit  1 = the value must contain a digit
# ---------------------------------------------------------------------------
rule_names=()
rule_regex=()
rule_ci=()
rule_need=()
rule_group=()
rule_digit=()
add_rule() {
  rule_names+=("$1")
  rule_regex+=("$2")
  rule_ci+=("${3:-0}")
  rule_need+=("${4:-}")
  rule_group+=("${5:-0}")
  rule_digit+=("${6:-0}")
}

q="[\"']"      # one quote character
sp='[[:space:]]*'
assign="${q}?${sp}[:=]${sp}"
secret_names='(pass''word|pass''wd|pass''phrase|sec''ret|tok''en|api[_-]?key|access[_-]?key|private[_-]?key|sec''ret[_-]?key|client[_-]?sec''ret|auth[_-]?key|creden''tial)s?'
secret_need='*pass* *sec''ret* *tok''en* *key* *creden''tial*'

add_rule "Anthropic API キー" 'sk''-ant-''[A-Za-z0-9_-]{20,}' 0 '*sk''-ant-*'
add_rule "OpenAI API キー" 'sk''-(proj|svcacct|admin)-''[A-Za-z0-9_-]{20,}' 0 '*sk''-*'
add_rule "AWS アクセスキー ID" '(AK''IA|AS''IA)''[0-9A-Z]{16}' 0 '*a[ks]''ia*'
add_rule "AWS シークレットアクセスキー" '(aws[_-]?sec''ret[a-z_-]*|sec''ret[_-]?access[_-]?key)'"${q}?${sp}[:=]${sp}${q}?"'[a-z0-9/+=]{40}' 1 '*sec''ret*'
add_rule "GitHub トークン" 'gh''[pousr]_''[A-Za-z0-9]{36,}' 0 '*gh''[pousr]_*'
add_rule "GitHub fine-grained トークン" 'github''_pat_''[A-Za-z0-9_]{22,}' 0 '*github''_pat_*'
add_rule "Slack トークン" 'xox''[abposr]-''[A-Za-z0-9-]{10,}' 0 '*xox''[abposr]-*'
add_rule "Google API キー" 'AI''za''[0-9A-Za-z_-]{35}' 0 '*ai''za*'
add_rule "Stripe の本番キー" '[rs]k_''live_''[0-9A-Za-z]{16,}' 0 '*k_''live_*'
add_rule "npm トークン" 'npm''_''[A-Za-z0-9]{36}' 0 '*npm''_*'
add_rule "Hugging Face トークン" 'hf''_''[A-Za-z0-9]{30,}' 0 '*hf''_*'
add_rule "JWT" 'ey''J[A-Za-z0-9_-]{10,}\.ey''J[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}' 0 '*ey''j*.ey''j*'
add_rule "秘密鍵の開始行" '-----''BEGIN ''([A-Z0-9]+ )*''PRIVATE'' KEY' 0 '*-----''begin*'
add_rule "PuTTY の秘密鍵" 'PuTTY-User''-Key-File-' 0 '*putty-user''-*'
# name = "value" (any language, quoted literal)
add_rule "パスワードなどの代入" "${secret_names}${assign}${q}"'([^"'"'"'[:space:]$]{8,})'"${q}" 1 "$secret_need" 2
# NAME=value on a line of its own (.env, ini, yaml); the value must contain a digit
add_rule "パスワードなどの代入" '^[[:space:]]*(export[[:space:]]+)?[a-z0-9_.-]*'"${secret_names}${sp}[:=]${sp}"'([^][(){}<>$.,;"'"'"'[:space:]]{8,})[[:space:]]*$' 1 "$secret_need" 3 1
add_rule "URL の中のパスワード" '[a-z][a-z0-9+.-]*://[^/[:space:]:@]+:([^/[:space:]@]+)@' 1 '*://*@*' 1
add_rule "Authorization ヘッダーの値" 'bear''er[[:space:]]+([a-z0-9._~+/=-]{20,})' 1 '*bear''er*' 1
add_rule "Authorization ヘッダーの値" 'authori''zation'"${q}?${sp}[:=]${sp}${q}?"'basic[[:space:]]+([a-z0-9+/=]{12,})' 1 '*authori''zation*' 1

# One regular expression made of every rule's pre-filter: most lines match
# none of them and skip the per-rule loop entirely.
rule_pre_re=""
for nds in "${rule_need[@]}"; do
  if [[ -z "$nds" ]]; then
    rule_pre_re=""
    break
  fi
  for nd in $nds; do
    nd="${nd#\*}"
    nd="${nd%\*}"
    nd="${nd//./\\.}"
    nd="${nd//\*/.*}"
    [[ -z "$nd" ]] && continue
    rule_pre_re+="${rule_pre_re:+|}$nd"
  done
done
[[ -z "$rule_pre_re" ]] && rule_pre_re='.'

at="@"
email_local_re='([A-Za-z0-9._%+-]+)$'
email_domain_re='^([A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})'
hx='[0-9A-Fa-f]'
uuid_re="${hx}{8}-${hx}{4}-${hx}{4}-${hx}{4}-${hx}{12}"
uuid_pre='*-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-*'

# Addresses that may appear (compared in lower case): a domain, any
# subdomain of example.com, or one of the exact addresses (GitHub merge
# commits, the Claude co-author line, SSH clone URLs).
allowed_domains=("users.noreply.github"".com" "example"".com")
allowed_subdomain_of="example"".com"
allowed_addresses=("noreply${at}anthropic"".com" "noreply${at}github"".com" "git${at}github"".com")

# Other spellings of the at sign that tools produce (percent-encoding, HTML
# entities, JSON escapes, the full-width sign, "[at]").
at_spellings=('%40' '&#64;' '&#x40;' '\u0040' '＠' ' [at] ' '[at]' ' (at) ' '(at)')
# Cheap pre-filter: a byte that starts one of the spellings above (the
# full-width sign starts with 0xEF).
at_pre=$'*[@%&\\\\[(\xef]*'

# Long lines are scanned in overlapping chunks so that the time stays linear.
chunk_len=4096
chunk_step=3712

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
  if [[ -L "$f" ]]; then
    die "禁止語リスト（ESM_DENYLIST_FILE）にシンボリックリンクは使えません。実体のファイルを指定してください"
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
  # Lower-cased so that case-insensitive file systems (macOS) are covered.
  if [[ "${abs,,}" == "${top,,}/"* ]]; then
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

py_bin=""
if command -v python3 >/dev/null 2>&1; then
  py_bin=$(command -v python3)
fi

# ---------------------------------------------------------------------------
# Scanning a piece of text. scan_text fills hit_sev/hit_msg; values are
# reported by length only so that the output never leaks them.
# ---------------------------------------------------------------------------
hit_sev=()
hit_msg=()

add_hit() {
  local k
  for k in "${!hit_msg[@]}"; do
    [[ "${hit_sev[$k]}" == "$1" && "${hit_msg[$k]}" == "$2" ]] && return
  done
  hit_sev+=("$1")
  hit_msg+=("$2")
}

masked=""
mask() { printf -v masked '[伏せた値・%d 文字]' "${#1}"; }

is_placeholder() {
  local v="${1,,}"
  case "$v" in
    *example* | *sample* | *dummy* | *placeholder* | *changeme* | *change_me* | *your* | \
      *redacted* | *xxxx* | *'****'* | *'...'* | '<'* | *'>' | '$'* | '%s')
      return 0
      ;;
  esac
  # A single character repeated.
  [[ -z "${v//"${v:0:1}"/}" ]] && return 0
  return 1
}

email_allowed() {
  local addr="$1" domain="${1##*"$at"}" d
  for d in "${allowed_addresses[@]}"; do [[ "$addr" == "$d" ]] && return 0; done
  for d in "${allowed_domains[@]}"; do [[ "$domain" == "$d" ]] && return 0; done
  [[ "$domain" == *".$allowed_subdomain_of" ]] && return 0
  return 1
}

# Look at a bounded window around each at sign instead of running one regular
# expression over the whole line (that was quadratic in the line length).
scan_emails() {
  local rest="$1" pre post left right lp s
  [[ "$rest" == *"$at"* ]] || return 0
  while [[ "$rest" == *"$at"* ]]; do
    pre="${rest%%"$at"*}"
    post="${rest#*"$at"}"
    if ((${#pre} > 64)); then left="${pre:${#pre}-64}"; else left="$pre"; fi
    right="${post:0:255}"
    if [[ "$left" =~ $email_local_re ]]; then
      lp="${BASH_REMATCH[1]}"
      if [[ "$right" =~ $email_domain_re ]]; then
        s="$lp$at${BASH_REMATCH[1]}"
        if ! email_allowed "$s"; then
          mask "$s"
          add_hit E "メールアドレス $masked"
        fi
      fi
    fi
    rest="$post"
  done
}

scan_chunk() {
  local t="$1" lower="${1,,}" i s g v e sp_at nd ok
  [[ "$lower" =~ $rule_pre_re ]] &&
  for i in "${!rule_regex[@]}"; do
    if [[ -n "${rule_need[i]}" ]]; then
      ok=0
      for nd in ${rule_need[i]}; do
        if [[ "$lower" == $nd ]]; then ok=1; break; fi
      done
      ((ok)) || continue
    fi
    if ((rule_ci[i])); then s="$lower"; else s="$t"; fi
    [[ "$s" =~ ${rule_regex[i]} ]] || continue
    v="${BASH_REMATCH[0]}"
    g="${rule_group[i]}"
    if ((g > 0)); then
      v="${BASH_REMATCH[g]}"
      is_placeholder "$v" && continue
      if ((rule_digit[i])) && [[ "$v" != *[0-9]* ]]; then continue; fi
    fi
    mask "$v"
    add_hit E "${rule_names[i]}の可能性 $masked"
  done

  if [[ "$lower" == $at_pre ]]; then
    e="$lower"
    for sp_at in "${at_spellings[@]}"; do
      e="${e//"$sp_at"/$at}"
    done
    scan_emails "$e"
  fi

  if [[ "$lower" == $uuid_pre && "$t" =~ $uuid_re ]]; then
    mask "${BASH_REMATCH[0]}"
    add_hit W "UUID 形式の文字列 $masked（止めません。公開してよい値か確認してください）"
  fi
}

scan_text() {
  hit_sev=()
  hit_msg=()
  local text="$1" n=${#1} start i lower
  if ((n <= chunk_len)); then
    scan_chunk "$text"
  else
    for ((start = 0; start < n; start += chunk_step)); do
      scan_chunk "${text:start:chunk_len}"
      ((start + chunk_len >= n)) && break
    done
  fi
  if ((${#deny_words[@]} > 0)); then
    lower="${text,,}"
    for i in "${!deny_words[@]}"; do
      if [[ "$lower" == *"${deny_words[$i]}"* ]]; then
        add_hit E "個人語に一致（禁止語リストの ${deny_lines[$i]} 行目）"
      fi
    done
  fi
}

# ---------------------------------------------------------------------------
# Units and findings. A unit is one scanned text (a file name, an added line,
# a message line, ...) described by a spec "kind<US>field<US>field...". All
# findings are printed at the end, so that a file name can be masked in every
# message once any check (including the python pass) has matched it.
# ---------------------------------------------------------------------------
US=$'\x1f'
units=()
unit=0
f_unit=()
f_sev=()
f_msg=()
declare -A f_seen=()
declare -A path_masked=()
errors=0
warnings=0

py_in=()
py_on=0
[[ -n "$py_bin" ]] && py_on=1

add_finding() { # unit sev msg [mask-path]
  local key="$1|$2|$3" spec="${units[$1]}"
  [[ -n "${f_seen[$key]+x}" ]] && return
  f_seen[$key]=1
  f_unit+=("$1")
  f_sev+=("$2")
  f_msg+=("$3")
  if [[ "${4:-1}" == 1 && "$spec" == "P$US"* ]]; then
    local pid="${spec#P"$US"}"
    path_masked[$pid]=1
  fi
}

check_unit() { # spec text
  local k
  units+=("$1")
  unit=$((${#units[@]} - 1))
  scan_text "$2"
  for k in "${!hit_msg[@]}"; do
    add_finding "$unit" "${hit_sev[$k]}" "${hit_msg[$k]}"
  done
  if ((py_on)); then
    py_in+=("L"$'\t'"$unit"$'\t'"$2")
  fi
}

# Path ids.
declare -A pid_of=()
path_name=()
get_pid() {
  if [[ -z "${pid_of[$1]+x}" ]]; then
    path_name+=("$1")
    pid_of[$1]=$((${#path_name[@]} - 1))
    pid=${pid_of[$1]}
    path_unit_of+=("")
    check_path "$pid" "$1"
  fi
  pid=${pid_of[$1]}
}
path_unit_of=()

is_guard() {
  case "$1" in
    .githooks/* | scripts/check-secrets.sh | scripts/claude-hook-bash.sh | .claude/settings.json | \
      .github/workflows/* | .gitattributes | */.gitattributes | .gitmodules)
      return 0
      ;;
  esac
  return 1
}

# Files whose removal or renaming switches a guard off.
is_core_guard() {
  case "$1" in
    .githooks/pre-commit | .githooks/commit-msg | .githooks/pre-push | scripts/check-secrets.sh | \
      scripts/claude-hook-bash.sh | .claude/settings.json | .github/workflows/check-secrets.yml)
      return 0
      ;;
  esac
  return 1
}

check_path() { # pid path
  local p="$2" base lbase lpath u
  base="${p##*/}"
  lbase="${base,,}"
  lpath="${p,,}"
  check_unit "P$US$1" "$p"
  u=$unit
  path_unit_of[$1]=$u

  local why=""
  case "$lbase" in
    .env.example | .env.sample | .env.template | .env.dist) ;;
    .env | .env.* | .envrc) why=".env 系" ;;
    *.pub) ;;
    id_rsa* | id_dsa* | id_ecdsa* | id_ed25519*) why="SSH の秘密鍵" ;;
    *.pem | *.key | *.p12 | *.pfx | *.ppk | *.keystore | *.jks | *.kdbx) why="鍵・証明書" ;;
    .netrc | _netrc | .npmrc | .pypirc | .git-credentials | .pgpass | .htpasswd) why="認証情報の設定" ;;
    credentials | credentials.* | *credential*.json | *service-account*.json | *service_account*.json) why="認証情報の設定" ;;
    .mcp.json) why="MCP の設定（トークンが入りやすい）" ;;
    claude.local.md) why="個人メモ" ;;
  esac
  if [[ "$lpath" == ".claude/settings.local.json" || "$lpath" == */.claude/settings.local.json ]]; then
    why="個人設定"
  fi
  case "/$lpath" in
    */secrets/* | */private/*) why="secrets/・private/ の下（.gitignore で除外している場所）" ;;
  esac
  if [[ -n "$why" ]]; then
    add_finding "$u" E "コミットしてはいけないファイル（$why）" 0
  fi
}

# ---------------------------------------------------------------------------
# Binary detection: Git's own rule (a NUL byte in the first 8000 bytes),
# applied to the blob itself so that .gitattributes cannot change the answer.
# ---------------------------------------------------------------------------
declare -A bin_cache=()
is_binary_blob() {
  local sha="$1" chunk rc
  if [[ -z "${bin_cache[$sha]+x}" ]]; then
    IFS= read -r -d '' -n 8000 chunk < <("${git_q[@]}" cat-file blob "$sha" 2>/dev/null)
    rc=$?
    if ((rc == 0 && ${#chunk} < 8000)); then bin_cache[$sha]=0; else bin_cache[$sha]=1; fi
  fi
  return "${bin_cache[$sha]}"
}

declare -A guard_warned=()
file_count=0
line_count=0
commit_count=0

handle_raw() { # status srcmode dstmode dstsha src dst
  local st="$1" smode="$2" dmode="$3" dsha="$4" src="$5" dst="$6" ext u
  case "$st" in
    D*)
      if is_core_guard "$dst"; then
        get_pid "$dst"
        add_finding "${path_unit_of[$pid]}" E "検査の仕組みのファイルを削除しています。外すなら、検査スクリプトと CLAUDE.md を直す変更として行ってください" 0
      fi
      return
      ;;
    U*) return ;;
  esac
  file_count=$((file_count + 1))
  get_pid "$dst"
  u="${path_unit_of[$pid]}"
  if [[ "$st" == R* ]] && is_core_guard "$src"; then
    local spid="$pid"
    get_pid "$src"
    add_finding "${path_unit_of[$pid]}" E "検査の仕組みのファイルの名前を変えています（元の場所では動かなくなります）" 0
    pid="$spid"
  fi
  if [[ "$dst" == .githooks/* && "$dmode" != 100755 ]]; then
    add_finding "$u" E "フックのファイルに実行権限がありません（モード $dmode）。Git が無視するので、100755 にしてください" 0
  fi
  if [[ "$mode" != "all" && -z "${guard_warned[$dst]+x}" ]] && is_guard "$dst"; then
    guard_warned[$dst]=1
    add_finding "$u" W "検査の仕組みに関わるファイルの変更です。検査を弱めていないか、レビューで確かめてください" 0
  fi
  case "$dmode" in
    100644 | 100755)
      if is_binary_blob "$dsha"; then
        ext="${dst##*.}"
        ext="${ext,,}"
        case "$ext" in
          png | jpg | jpeg | gif | webp | ico | bmp | avif)
            add_finding "$u" W "画像のファイルです。中のメタデータ（撮影した位置、作成者など）は検査していません。exiftool などで消してから入れてください" 0
            ;;
          *)
            add_finding "$u" E "Git がバイナリとみなすファイルです（UTF-16 で保存したテキストも含む）。中身を確かめきれないため止めます。テキストなら UTF-8 で保存し直してください" 0
            ;;
        esac
      fi
      ;;
    160000)
      add_finding "$u" W "サブモジュールです。中身は検査していません" 0
      ;;
  esac
}

parse_raw_line() { # ":smode dmode ssha dsha status<TAB>path[<TAB>path]"
  local line="$1" meta paths src dst
  meta="${line%%$'\t'*}"
  paths="${line#*$'\t'}"
  local -a f
  read -r -a f <<<"${meta#:}"
  if [[ "${f[4]}" == R* || "${f[4]}" == C* ]]; then
    src="${paths%%$'\t'*}"
    dst="${paths#*$'\t'}"
  else
    src="$paths"
    dst="$paths"
  fi
  handle_raw "${f[4]}" "${f[0]}" "${f[1]}" "${f[3]}" "$src" "$dst"
}

# Lines added to a .gitattributes file that would hide content from diffs.
check_gitattributes_line() { # unit text
  local l="${2,,}" tok
  [[ "$l" =~ ^[[:space:]]*# ]] && return
  local -a toks
  read -r -a toks <<<"$l"
  for tok in "${toks[@]:1}"; do
    case "$tok" in
      binary | -diff | diff=* | filter=* | textconv*)
        add_finding "$1" E "検査や差分の表示を弱める属性（$tok）です。中身が差分に出なくなるため止めます" 0
        ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# Streams: raw (names, modes, blobs) and patch (added lines).
# ---------------------------------------------------------------------------
run_raw() {
  local line commit="" fd p
  exec {fd}< <("$@")
  p=$!
  while IFS= read -r -u "$fd" line; do
    case "$line" in
      "commit "*) commit="${line#commit }" ;;
      :*) parse_raw_line "$line" ;;
    esac
  done
  exec {fd}<&-
  wait "$p" || die "変更されたファイルの一覧を取得できません"
}

run_patch() {
  local line commit="" file="" lineno=0 in_header=0 p fd pp hunk_re='^@@ -[0-9,]+ \+([0-9]+)'
  exec {fd}< <("$@")
  pp=$!
  while IFS= read -r -u "$fd" line; do
    case "$line" in
      "commit "*)
        # Only emitted by --format; diff content lines always carry a
        # one-character prefix, so this cannot be file content.
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
          if [[ "$p" == "/dev/null" ]]; then
            file=""
          elif [[ "$p" == '"b/'* ]]; then
            file="\"${p#\"b/}"
          else
            file="${p#b/}"
          fi
        elif [[ -n "$file" ]]; then
          add_line "$commit" "$file" "$lineno" "${line:1}"
          lineno=$((lineno + 1))
        fi
        ;;
      "@@ "*)
        in_header=0
        if [[ "$line" =~ $hunk_re ]]; then lineno="${BASH_REMATCH[1]}"; fi
        ;;
      "+"*)
        if ((in_header == 0)) && [[ -n "$file" ]]; then
          add_line "$commit" "$file" "$lineno" "${line:1}"
          lineno=$((lineno + 1))
        fi
        ;;
    esac
  done
  exec {fd}<&-
  wait "$pp" || die "差分を取得できません"
}

add_line() { # commit file lineno text
  line_count=$((line_count + 1))
  get_pid "$2"
  check_unit "L$US$pid$US$1$US$3" "$4"
  if [[ "${2##*/}" == ".gitattributes" ]]; then
    check_gitattributes_line "$unit" "$4"
  fi
}

# Commit metadata: author, committer and message of each commit.
run_meta() {
  local rec c c8 author committer msg ml n
  while IFS= read -r -d '' rec || [[ -n "$rec" ]]; do
    c="${rec%%"$US"*}"
    rec="${rec#*"$US"}"
    author="${rec%%"$US"*}"
    rec="${rec#*"$US"}"
    committer="${rec%%"$US"*}"
    msg="${rec#*"$US"}"
    c="${c#$'\n'}"
    c8="${c:0:8}"
    commit_count=$((commit_count + 1))
    check_unit "I$US$c8${US}作成者" "$author"
    check_unit "I$US$c8${US}コミッター" "$committer"
    n=0
    while IFS= read -r ml; do
      n=$((n + 1))
      check_unit "M$US$c8$US$n" "$ml"
    done <<<"$msg"
  done < <("${git_q[@]}" log -z --format="%H%x1f%an <%ae>%x1f%cn <%ce>%x1f%B" "$@")
  wait $! || die "コミットの情報を取得できません"
}

declare -A tag_seen=()
scan_tag() { # sha
  local sha="$1" line n=0
  [[ -n "${tag_seen[$sha]+x}" ]] && return
  tag_seen[$sha]=1
  while IFS= read -r line; do
    n=$((n + 1))
    case "$line" in "object "* | "type "*) continue ;; esac
    check_unit "T$US${sha:0:8}$US$n" "$line"
  done < <("${git_q[@]}" cat-file tag "$sha")
  wait $! || die "タグを読めません: ${sha:0:8}"
}

ref_count=0
scan_ref_name() { # name
  ref_count=$((ref_count + 1))
  check_unit "R$US$ref_count" "$1"
}

# ---------------------------------------------------------------------------
# Collect and scan according to the mode.
# ---------------------------------------------------------------------------
diff_opts=(--no-color --no-ext-diff --text --no-textconv -U0 -M --src-prefix=a/ --dst-prefix=b/)
revs=()
scope=""

case "$mode" in
  staged)
    scope="ステージされた変更"
    run_raw "${git_q[@]}" diff --cached --raw --no-abbrev -M
    run_patch "${git_q[@]}" diff --cached -p "${diff_opts[@]}" --diff-filter=d
    ;;

  message)
    scope="コミットメッセージと作成者"
    [[ -f "$msg_file" && -r "$msg_file" ]] || die "コミットメッセージのファイルを読めません: $msg_file"
    cc=$(git config --get core.commentChar 2>/dev/null)
    [[ ${#cc} -eq 1 ]] || cc="#"
    scissors="$cc ------------------------ >8 ------------------------"
    n=0
    while IFS= read -r ml || [[ -n "$ml" ]]; do
      ml="${ml%$'\r'}"
      # Everything below the scissors line (git commit -v) is a diff that
      # Git removes from the message.
      [[ "$ml" == "$scissors" ]] && break
      n=$((n + 1))
      check_unit "M$US$US$n" "$ml"
    done <"$msg_file"
    commit_count=1
    for who in AUTHOR COMMITTER; do
      ident=$(git var "GIT_${who}_IDENT" 2>/dev/null) || die "作成者・コミッターの情報を取得できません（user.name と user.email を設定してください）"
      # Drop the trailing "<timestamp> <zone>".
      ident="${ident% *}"
      ident="${ident% *}"
      if [[ "$who" == AUTHOR ]]; then label="作成者"; else label="コミッター"; fi
      check_unit "I$US$US$label" "$ident"
    done
    ;;

  push | range | all)
    tag_objs=()
    if [[ "$mode" == "range" ]]; then
      scope="指定範囲のコミット"
      sha=$(git rev-parse --verify -q "$range_head^{commit}") || die "コミットとして解決できません: $range_head"
      revs=("$sha")
      zero_re='^0+$'
      if [[ ! "$range_base" =~ $zero_re ]]; then
        sha=$(git rev-parse --verify -q "$range_base^{commit}") || die "コミットとして解決できません: $range_base"
        revs+=(--not "$sha")
      fi
    elif [[ "$mode" == "all" ]]; then
      scope="全履歴（すべての参照）"
      revs=(--all)
      while IFS=' ' read -r otype oname rname; do
        [[ -z "$rname" ]] && continue
        scan_ref_name "$rname"
        [[ "$otype" == "tag" ]] && tag_objs+=("$oname")
      done < <("${git_q[@]}" for-each-ref --format='%(objecttype) %(objectname) %(refname)')
      wait $! || die "参照の一覧を取得できません"
    else
      scope="リモートにないコミット"
      if ((${#push_tips[@]} == 0)) && git rev-parse --verify -q HEAD >/dev/null; then
        push_tips=(HEAD)
      fi
      for t in "${push_tips[@]}"; do
        # "^{object}" makes rev-parse check that the object exists (a bare
        # full-length hash is otherwise accepted as is).
        sha=$(git rev-parse --verify -q "$t^{object}") || die "コミットとして解決できません: $t"
        if [[ "$(git cat-file -t "$sha")" == "tag" ]]; then
          tag_objs+=("$sha")
        fi
        # A tag may point at something other than a commit; then only the
        # tag itself is scanned.
        if csha=$(git rev-parse --verify -q "$sha^{commit}"); then
          revs+=("$csha")
        fi
      done
      if ((${#revs[@]} > 0)); then
        excl=()
        if ((push_remote_set)); then
          excl+=(--remotes="$push_remote")
        elif ((!no_remotes)); then
          excl+=(--remotes)
        fi
        for b in "${push_bases[@]}"; do
          sha=$(git rev-parse --verify -q "$b^{commit}") || die "コミットとして解決できません: $b"
          excl+=("$sha")
        done
        ((${#excl[@]} > 0)) && revs+=(--not "${excl[@]}")
      fi
    fi

    for r in "${ref_args[@]}"; do
      scan_ref_name "$r"
      if [[ "$mode" == "range" && "$r" == refs/tags/* ]] &&
        sha=$(git rev-parse --verify -q "$r") &&
        [[ "$(git cat-file -t "$sha")" == "tag" ]]; then
        tag_objs+=("$sha")
      fi
    done
    for t in "${tag_objs[@]}"; do scan_tag "$t"; done

    if ((${#revs[@]} > 0)); then
      run_raw "${git_q[@]}" log --format='commit %H' --raw --no-abbrev -M --diff-merges=first-parent "${revs[@]}"
      run_patch "${git_q[@]}" log --format='commit %H' -p "${diff_opts[@]}" --diff-filter=d --diff-merges=first-parent "${revs[@]}"
      run_meta "${revs[@]}"
    fi
    ;;
esac

# ---------------------------------------------------------------------------
# The python pass: personal words after Unicode normalisation (NFKC, case
# folding, katakana to hiragana, look-alike letters, without spaces, zero
# width characters, hyphens and middle dots), lines decoded as Shift_JIS or
# EUC-JP when they are not UTF-8, and base64/hex tokens decoded once. Decoded
# text is sent back to the bash rules above.
# ---------------------------------------------------------------------------
read -r -d '' py_code <<'PY'
import base64, binascii, re, sys, unicodedata

CONF = str.maketrans({
    '\u0430': 'a', '\u0435': 'e', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c',
    '\u0443': 'y', '\u0445': 'x', '\u0456': 'i', '\u0458': 'j', '\u0455': 's',
    '\u0501': 'd', '\u04bb': 'h', '\u04cf': 'l', '\u0261': 'g', '\u03b1': 'a',
    '\u03bf': 'o', '\u03c1': 'p', '\u03bd': 'v', '\u03ba': 'k', '\u03b9': 'i',
})
DROP = re.compile('[\\s\u00ad\u200b-\u200f\u2028-\u202f\u205f-\u2064\ufeff'
                  '\\-\u2010-\u2015\u2212\u30fb\u00b7_.]+')
B64 = re.compile(rb'[A-Za-z0-9+/_-]{24,}={0,2}')
HEX = re.compile(rb'(?:[0-9A-Fa-f]{2}){16,}')
CTRL = re.compile('[\x00-\x1f\x7f]')


def norm(s):
    s = unicodedata.normalize('NFKC', s).casefold().translate(CONF)
    s = ''.join(chr(ord(c) - 0x60) if '\u30a1' <= c <= '\u30f6' else c for c in s)
    return DROP.sub('', s)


def decodings(b):
    try:
        return [b.decode('utf-8')]
    except UnicodeDecodeError:
        pass
    out = []
    for enc in ('cp932', 'euc_jp'):
        try:
            out.append(b.decode(enc))
        except UnicodeDecodeError:
            pass
    out.append(b.decode('utf-8', 'replace'))
    return out


def printable(raw):
    try:
        s = raw.decode('utf-8')
    except UnicodeDecodeError:
        return None
    if len(s) < 8:
        return None
    good = sum(1 for c in s if c.isprintable())
    return s if good >= 0.95 * len(s) else None


def decoded_tokens(b):
    for m in B64.finditer(b):
        tok = m.group(0)
        if HEX.fullmatch(tok):
            continue
        t = tok.rstrip(b'=').replace(b'+', b'-').replace(b'/', b'_')
        if len(t) % 4 == 1:
            t = t[:-1]
        try:
            raw = base64.urlsafe_b64decode(t + b'=' * (-len(t) % 4))
        except (binascii.Error, ValueError):
            continue
        s = printable(raw)
        if s:
            yield 'base64', s
    for m in HEX.finditer(b):
        s = printable(bytes.fromhex(m.group(0).decode('ascii')))
        if s:
            yield '16 進', s


def main():
    out = []
    words = []
    count = 0
    for raw in sys.stdin.buffer:
        raw = raw.rstrip(b'\n')
        kind, _, rest = raw.partition(b'\t')
        if kind == b'W':
            n, _, w = rest.partition(b'\t')
            nw = norm(w.decode('utf-8', 'replace'))
            if nw:
                words.append((n.decode('ascii'), nw))
            continue
        if kind != b'L':
            continue
        count += 1
        u, _, text = rest.partition(b'\t')
        u = u.decode('ascii')
        found = set()
        if words:
            for d in decodings(text):
                nd = norm(d)
                for n, w in words:
                    if w in nd:
                        found.add((n, '-'))
        for how, s in decoded_tokens(text):
            s = CTRL.sub(' ', s)
            out.append('X\t%s\t%s\t%s' % (u, how, s))
            if words:
                ns = norm(s)
                for n, w in words:
                    if w in ns:
                        found.add((n, how))
        for n, how in sorted(found):
            out.append('D\t%s\t%s\t%s' % (u, n, how))
    out.append('OK\t%d' % count)
    sys.stdout.buffer.write(('\n'.join(out) + '\n').encode('utf-8', 'replace'))


main()
PY

py_status=""
if ((py_on)); then
  py_ok=""
  sent=$((${#py_in[@]}))
  while IFS=$'\t' read -r tag a b c; do
    case "$tag" in
      D)
        sfx=""
        [[ "$c" != "-" ]] && sfx="（$c を復号した中身）"
        add_finding "$a" E "個人語に一致（禁止語リストの $b 行目）$sfx"
        ;;
      X)
        scan_text "$c"
        for k in "${!hit_msg[@]}"; do
          add_finding "$a" "${hit_sev[$k]}" "${hit_msg[$k]}（$b を復号した中身）"
        done
        ;;
      OK) py_ok="$a" ;;
    esac
  done < <(
    {
      for i in "${!deny_words[@]}"; do printf 'W\t%s\t%s\n' "${deny_lines[$i]}" "${deny_words[$i]}"; done
      ((sent > 0)) && printf '%s\n' "${py_in[@]}"
    } | "$py_bin" -I -c "$py_code"
  )
  wait $! || die "python3 による検査が失敗しました"
  [[ "$py_ok" == "$sent" ]] || die "python3 による検査の結果が不完全です（送った ${sent} 件、検査した ${py_ok:-0} 件）"
else
  py_status="python3 がないため、個人語の表記ゆれ（全角・空白・かな・Shift_JIS など）と、base64・16 進で符号化された値の検査は未実施"
fi

# ---------------------------------------------------------------------------
# Report.
# ---------------------------------------------------------------------------
path_label() { # pid
  if [[ -n "${path_masked[$1]+x}" ]]; then
    printf -v label '（伏せたファイル名#%d）' "$(($1 + 1))"
    any_masked=1
  else
    label="${path_name[$1]}"
  fi
}

any_masked=0
any_ref=0
label=""
where=""
format_where() { # unit
  local -a s
  IFS="$US" read -r -a s <<<"${units[$1]}"
  case "${s[0]}" in
    P)
      path_label "${s[1]}"
      where="$label(ファイル名)"
      ;;
    L)
      path_label "${s[1]}"
      where="${s[2]:+${s[2]}:}$label:${s[3]}"
      ;;
    M) where="${s[1]:+${s[1]}:}コミットメッセージ:${s[2]}" ;;
    I) where="${s[1]:+${s[1]}:}${s[2]}" ;;
    T) where="タグ ${s[1]}:${s[2]}" ;;
    R)
      where="参照名#${s[1]}"
      any_ref=1
      ;;
    *) where="?" ;;
  esac
}

for k in "${!f_unit[@]}"; do
  format_where "${f_unit[$k]}"
  if [[ "${f_sev[$k]}" == E ]]; then
    errors=$((errors + 1))
    printf '%s: 停止: %s: %s\n' "$prog" "$where" "${f_msg[$k]}" >&2
  else
    warnings=$((warnings + 1))
    printf '%s: 警告: %s: %s\n' "$prog" "$where" "${f_msg[$k]}" >&2
  fi
done

if ((any_masked)); then
  note "一致があったファイル名は伏せて表示しています（#番号は、この回に見たファイルの順番）。git diff --cached --name-only や git log --name-only で確かめてください"
fi
if ((any_ref)); then
  note "参照名（ブランチ名・タグ名）は伏せて表示しています（#番号は、検査した参照の順番）"
fi

if [[ "$mode" == "staged" || "$mode" == "push" || "$mode" == "message" ]]; then
  hp=$(git config --get core.hooksPath 2>/dev/null)
  if [[ "$hp" != ".githooks" && "$hp" != "$repo_root/.githooks" ]]; then
    note "Git のフックが有効になっていません。クローンしたら最初に git config core.hooksPath .githooks を実行してください"
  fi
fi

for n in "${notes[@]}"; do
  printf '%s: 注意: %s\n' "$prog" "$n" >&2
done
[[ -n "$py_status" ]] && printf '%s: 注意: %s\n' "$prog" "$py_status" >&2
if [[ -n "$deny_status" ]]; then
  printf '%s: 注意: 個人語の検査は未実施（%s）\n' "$prog" "$deny_status" >&2
  if ((require_deny)); then
    printf '%s: 停止: 個人語の検査ができないため止めます（--require-denylist）\n' "$prog" >&2
    errors=$((errors + 1))
  fi
else
  printf '%s: 個人語の検査を実施（禁止語 %d 件）\n' "$prog" "${#deny_words[@]}" >&2
fi

printf '%s: 対象=%s コミット=%d ファイル=%d 追加行=%d 停止=%d 警告=%d\n' \
  "$prog" "$scope" "$commit_count" "$file_count" "$line_count" "$errors" "$warnings" >&2

if ((errors > 0)); then
  printf '%s: 問題が見つかったため中止します。該当箇所を修正してから再実行してください。\n' "$prog" >&2
  exit 2
fi
exit 0
