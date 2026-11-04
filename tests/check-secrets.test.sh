#!/usr/bin/env bash
# check-secrets.test.sh - Automated tests for scripts/check-secrets.sh, the Git
# hooks in .githooks/ and scripts/claude-hook-bash.sh.
#
# Usage: bash tests/check-secrets.test.sh [<group>...]
#   With no argument every group runs. A group is one of the names printed in
#   the "== group" lines (for example: basic cs01 cs02).
#
# Every case runs in a throwaway repository (with a throwaway bare remote)
# under a temporary directory; nothing touches this repository and nothing is
# pushed anywhere else. Commits that contain fake leaks are made with Git
# plumbing (commit-tree), never by switching the hooks off. Fake keys,
# addresses and personal words are assembled from fragments at run time, so
# this file never matches the rules it tests (it is itself scanned whenever it
# is committed). Global and system Git configuration are ignored.
#
# Exit status: 0 when every case passed, 1 otherwise.

set -u
export LC_ALL=C

here=$(cd "$(dirname "$0")" && pwd -P)
root=$(cd "$here/.." && pwd -P)
work=$(mktemp -d "${TMPDIR:-/tmp}/check-secrets-test.XXXXXX") || exit 1
trap 'rm -rf "$work"' EXIT

# Isolate Git from the machine's configuration.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
for v in $(compgen -e); do
  case "$v" in GIT_CONFIG_COUNT | GIT_CONFIG_PARAMETERS | GIT_CONFIG_KEY_* | GIT_CONFIG_VALUE_*) unset "$v" ;; esac
done
unset ESM_DENYLIST_FILE GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
export GIT_AUTHOR_NAME="Test User" GIT_COMMITTER_NAME="Test User"
export GIT_AUTHOR_EMAIL="test""@""example.com" GIT_COMMITTER_EMAIL="test""@""example.com"
export GIT_EDITOR=: GIT_TERMINAL_PROMPT=0

have_py=0
command -v python3 >/dev/null 2>&1 && have_py=1

# ---------------------------------------------------------------------------
# Fake values, assembled from fragments.
# ---------------------------------------------------------------------------
rep() {
  local s="" i
  for ((i = 0; i < $2; i++)); do s+="$1"; done
  printf '%s' "$s"
}
mixed() { rep "Ab3dE" $(($1 / 5)); } # not a placeholder (not one repeated character)

KEY_ANT="sk""-an""t-api03-$(rep Q 40)"
KEY_GH="gh""p_$(rep R 36)"
KEY_AWS="AK""IA$(rep Z 16)"
PEM_LINE="-----""BEGIN"" RSA ""PRIVATE"" KEY-----"
MAIL="fake.person""@""mail.example.invalid"
MAIL_LOCAL="fake.person"
MAIL_DOMAIN="mail.example.invalid"
OK_MAILS=("someone""@""example.com" "1234+someone""@""users.noreply.github.com"
  "noreply""@""anthropic.com" "git""@""github.com")
WORD="zqxv""morl"                 # a fictional word for the personal list
WORD_JA="架空""名称"               # a fictional four-kanji word
WORD_HIRA="かくう""めいしょう"     # a fictional reading in hiragana
WORD_KATA="カクウ""メイショウ"     # the same reading in katakana
PW="Zq7w""9Rt2kLm"                 # a password-like value
UUID_V="0f0e0d0c-""0b0a-4908-8706-""050403020100"

# ---------------------------------------------------------------------------
# Test helpers.
# ---------------------------------------------------------------------------
passed=0
failed=0
skipped=0
out="$work/out"

ok() {
  passed=$((passed + 1))
  printf 'ok    %s\n' "$1"
}
ng() {
  failed=$((failed + 1))
  printf 'FAIL  %s\n' "$1"
  [[ -f "$out" ]] && sed 's/^/      | /' "$out" | head -40
}
skip() {
  skipped=$((skipped + 1))
  printf 'skip  %s\n' "$1"
}

# expect <name> <status> <command...>: run the command, keep its output.
expect() {
  local name="$1" want="$2" rc
  shift 2
  "$@" >"$out" 2>&1
  rc=$?
  if [[ "$rc" == "$want" ]]; then ok "$name"; else ng "$name (終了コード $want を期待、実際は $rc)"; fi
}
stops() { expect "$1" 2 "${@:2}"; }
passes() { expect "$1" 0 "${@:2}"; }
fails() { # any non-zero status (git commit and git push report 1)
  local name="$1" rc
  shift
  "$@" >"$out" 2>&1
  rc=$?
  if ((rc != 0)); then ok "$name"; else ng "$name (失敗を期待、実際は成功)"; fi
}
out_has() { if grep -qF -- "$2" "$out"; then ok "$1"; else ng "$1"; fi; }
out_lacks() { if grep -qF -- "$2" "$out"; then ng "$1"; else ok "$1"; fi; }

# A fresh repository with the scanner, the hooks enabled, one clean commit and
# a bare remote "origin" that already has it.
n=0
new_repo() {
  n=$((n + 1))
  R="$work/r$n"
  B="$work/b$n.git"
  git init -q -b main "$R" || exit 1
  mkdir -p "$R/scripts" "$R/.githooks"
  cp "$root/scripts/check-secrets.sh" "$root/scripts/claude-hook-bash.sh" "$R/scripts/"
  cp "$root/.githooks/pre-commit" "$root/.githooks/commit-msg" "$root/.githooks/pre-push" "$R/.githooks/"
  chmod +x "$R/.githooks/"*
  cd "$R" || exit 1
  git config core.hooksPath .githooks
  echo "init" >README.md
  git add -A
  if ! git commit -q -m "init" >"$out" 2>&1; then
    echo "setup: the initial commit failed"
    cat "$out"
    exit 1
  fi
  git init -q --bare "$B"
  git remote add origin "$B"
  if ! git push -q origin main >"$out" 2>&1; then
    echo "setup: the initial push failed"
    cat "$out"
    exit 1
  fi
  unset ESM_DENYLIST_FILE
}

CHK() { bash "$R/scripts/check-secrets.sh" "$@"; }

# Write a file and stage it.
stage() { # path content
  mkdir -p "$(dirname "$1")"
  printf '%s\n' "$2" >"$1"
  git add -f -- "$1"
}

# Unstage and remove everything since the last commit.
clean() {
  git reset -q --hard HEAD
  git clean -qfdx
}

# Make a commit on the current branch with plumbing (no hooks run).
plumb_commit() { # message [path content]
  local tree c
  if (($# >= 3)); then stage "$2" "$3"; fi
  tree=$(git write-tree)
  c=$(printf '%s\n' "$1" | git commit-tree "$tree" -p HEAD) || return 1
  git update-ref HEAD "$c"
}

denylist() { # words...
  local f="$work/denylist.txt"
  printf '%s\n' "# fictional words for the tests" "" "$@" >"$f"
  export ESM_DENYLIST_FILE="$f"
}

remote_main() { git --git-dir="$B" rev-parse -q --verify refs/heads/main; }

hook_json() { printf '{"tool_name":"Bash","tool_input":{"command":"%s"}}' "$1"; }
run_hook() { hook_json "$1" | CLAUDE_PROJECT_DIR="$R" bash "$R/scripts/claude-hook-bash.sh"; }

py_conv() { # mode text -> converted bytes
  printf '%s' "$2" | python3 -I -c '
import base64, sys
m = sys.argv[1]
s = sys.stdin.buffer.read()
t = s.decode("utf-8")
if m == "fullwidth":
    sys.stdout.buffer.write("".join(chr(ord(c) + 0xFEE0) if "!" <= c <= "~" else c for c in t).encode("utf-8"))
elif m == "base64":
    sys.stdout.buffer.write(base64.b64encode(s))
elif m == "hex":
    sys.stdout.buffer.write(s.hex().encode("ascii"))
else:
    sys.stdout.buffer.write(t.encode(m))
' "$1"
}

utf16le() { # text -> UTF-16LE with BOM (ASCII text only)
  local s="$1" i
  printf '\xff\xfe'
  for ((i = 0; i < ${#s}; i++)); do printf '%s\0' "${s:i:1}"; done
  printf '\n\0'
}

# ---------------------------------------------------------------------------
# Groups.
# ---------------------------------------------------------------------------
t_basic() {
  new_repo
  passes "変更なしは通す" CHK --staged
  stage a.txt "ok"
  passes "問題のない変更は通す" CHK --staged
  clean
  local v
  for v in "$KEY_ANT" "$KEY_GH" "$KEY_AWS" "$PEM_LINE" "x = $MAIL"; do
    stage a.txt "value: $v"
    stops "決まった形の秘密情報・メールアドレスを止める (${v:0:3}…)" CHK --staged
    out_lacks "出力に値そのものを出さない (${v:0:3}…)" "$v"
    clean
  done
  for v in "${OK_MAILS[@]}"; do
    stage a.txt "contact: $v"
    passes "許可したアドレスは通す (${v#*@})" CHK --staged
    clean
  done
  stage a.txt "id: $UUID_V"
  passes "UUID は通す" CHK --staged
  out_has "UUID は警告を出す" "UUID 形式"
  clean
  stops "--staged に余計な引数は止める" CHK --staged extra
  stops "--push に存在しないコミットは止める" CHK --push 0123456789abcdef0123456789abcdef01234567
  stops "--ref を --staged と使うと止める" CHK --staged --ref refs/heads/main
  passes "--all は問題のない履歴を通す" CHK --all
}

t_cs01() {
  new_repo
  local head
  head=$(git rev-parse HEAD)
  echo x >b.txt
  git add b.txt
  fails "commit-msg: メッセージのキーで止める" git commit -q -m "add file, key $KEY_ANT"
  [[ "$(git rev-parse HEAD)" == "$head" ]] && ok "commit-msg: コミットされていない" || ng "commit-msg: コミットされていない"
  fails "commit-msg: メッセージのメールアドレスで止める" git commit -q -m "by $MAIL"
  fails "commit-msg: 作成者のメールアドレスで止める" env GIT_AUTHOR_EMAIL="$MAIL" git commit -q -m "normal"
  fails "commit-msg: コミッターのメールアドレスで止める" env GIT_COMMITTER_EMAIL="$MAIL" git commit -q -m "normal"
  denylist "$WORD"
  fails "commit-msg: 作成者の名前の個人語で止める" env GIT_AUTHOR_NAME="Dr $WORD" git commit -q -m "normal"
  unset ESM_DENYLIST_FILE
  passes "commit-msg: 共同作成者の行（Claude の noreply）は通す" git commit -q -m "normal" -m "Co-Authored-By: Claude <noreply""@""anthropic.com>"
  {
    echo "subject"
    echo "# ------------------------ >8 ------------------------"
    echo "-removed $KEY_ANT"
  } >"$work/msg.txt"
  passes "commit-msg: はさみの行より下（git commit -v の差分）は見ない" CHK --message "$work/msg.txt"
  git push -q origin main >"$out" 2>&1

  head=$(remote_main)
  plumb_commit "key $KEY_ANT" c.txt "ok"
  fails "pre-push: メッセージのキーで止める" git push -q origin main
  [[ "$(remote_main)" == "$head" ]] && ok "pre-push: リモートに届いていない" || ng "pre-push: リモートに届いていない"
  stops "--range: メッセージのキーで止める（CI）" CHK --range "$head" HEAD
  git reset -q --hard "$head"

  GIT_AUTHOR_EMAIL="$MAIL" plumb_commit "normal" c.txt "ok"
  fails "pre-push: 作成者のメールアドレスで止める" git push -q origin main
  stops "--range: 作成者のメールアドレスで止める（CI）" CHK --range "$head" HEAD
  git reset -q --hard "$head"

  denylist "$WORD"
  git checkout -q -b "feature/$WORD"
  plumb_commit "normal" d.txt "ok"
  fails "pre-push: ブランチ名の個人語で止める" git push -q origin "feature/$WORD"
  out_lacks "ブランチ名を出力に出さない" "$WORD"
  git checkout -q main
  git branch -q -D "feature/$WORD"
  unset ESM_DENYLIST_FILE

  git tag -a lab-tag -m "release $KEY_ANT"
  fails "pre-push: 注釈付きタグのメッセージで止める" git push -q origin lab-tag
  git tag -d lab-tag >/dev/null
  git tag -a lab-tag2 -m "release" 2>/dev/null
  passes "pre-push: 問題のないタグは通す" git push -q origin lab-tag2
  git push -q origin :refs/tags/lab-tag2 >"$out" 2>&1
  out_has "pre-push: 削除だけのときは省略を伝える" "省略"
}

t_cs02() {
  new_repo
  utf16le "key=$KEY_ANT" >u16.txt
  git add u16.txt
  stops "UTF-16 のファイルを止める" CHK --staged
  out_has "UTF-16 の理由を伝える" "UTF-16"
  clean
  { printf '\0\n'; printf '%s\n' "key=$KEY_ANT"; } >nul.txt
  git add nul.txt
  stops "NUL を含むファイルを止める" CHK --staged
  out_has "NUL を含むファイルでもキーを見つける" "Anthropic"
  clean
  printf '%s\n' "a.txt -diff" >.gitattributes
  stage a.txt "key=$KEY_ANT"
  git add .gitattributes
  stops ".gitattributes の -diff でもキーを止める" CHK --staged
  out_has "-diff の属性を止める" "（-diff）"
  out_has "-diff の指定があってもキーを見つける" "Anthropic"
  clean
  stage t/.gitattributes "* binary"
  stage t/a.txt "key=$KEY_ANT"
  stops "サブディレクトリの .gitattributes の binary でも止める" CHK --staged
  clean
  if command -v gzip >/dev/null 2>&1; then
    printf '%s\n' "key=$KEY_ANT" | gzip -c >k.gz
    git add k.gz
    stops "圧縮ファイルを止める" CHK --staged
    clean
  else
    skip "圧縮ファイルを止める（gzip がない）"
  fi
  printf '\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\1' >img.png
  git add img.png
  passes "画像は通す" CHK --staged
  out_has "画像はメタデータの警告を出す" "メタデータ"
  clean
  git config core.attributesFile "$work/attrs"
  printf '%s\n' "* -diff" >"$work/attrs"
  stage a.txt "key=$KEY_ANT"
  stops "手元の core.attributesFile でも止める（CS-19）" CHK --staged
  git config --unset core.attributesFile
  clean
}

t_cs03() {
  new_repo
  ln -s README.md link.txt
  git add link.txt
  git commit -q -m "link" >"$out" 2>&1 || ng "シンボリックリンクのコミット"
  rm link.txt
  printf '%s\n' "key=$KEY_ANT" >link.txt
  git add link.txt
  stops "シンボリックリンクを通常のファイルにした変更を止める" CHK --staged
  fails "シンボリックリンクの置き換えのコミットを止める" git commit -q -m "replace link"
}

t_cs04() {
  new_repo
  stops "フック: --no-verify を止める" run_hook "git commit --no-verify -m x"
  stops "フック: git push --no-verify を止める" run_hook "git push --no-verify origin main"
  stops "フック: -c core.hooksPath を止める" run_hook "git add k.txt && git -c core.hooksPath=/dev/null commit -m x"
  stops "フック: 環境変数での hooksPath を止める" run_hook "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/x git commit -m x"
  stops "フック: hooksPath の読み取りも止める" run_hook "git config --get core.hooksPath"
  passes "フック: .githooks に設定し直すのは通す" run_hook "git config core.hooksPath .githooks"
  stops "フック: git commit -n を止める" run_hook "git commit -n -m x"
  stops "フック: git commit -an を止める" run_hook "git commit -an -m x"
  passes "フック: git commit -am は通す" run_hook "git commit -am x"
  passes "フック: 関係のないコマンドは通す" run_hook "ls -la"
  passes "フック: head -n は通す" run_hook "git log --oneline && head -n 3 README.md"
  chmod -x .githooks/pre-commit
  stops "フック: Git のフックに実行権限がないと止める" run_hook "git commit -m x"
  chmod +x .githooks/pre-commit
  git config core.hooksPath /dev/null
  stops "フック: Git のフックが無効だと止める" run_hook "git commit -m x"
  git config core.hooksPath .githooks
  stage k.txt "key=$KEY_ANT"
  stops "フック: ステージにキーがあれば止める" run_hook "git commit -m x"
  stops "フック: 絶対パスの git でも検査する（CS-18）" run_hook "/usr/bin/git commit -m x"
  stops "フック: エイリアスでも検査する（CS-18）" run_hook "git ci -m commit"
  clean
}

t_cs05() {
  new_repo
  git update-index --chmod=-x .githooks/pre-commit
  stops "フックの実行権限を外す変更を止める" CHK --staged
  out_has "実行権限の理由を伝える" "実行権限"
  git update-index --chmod=+x .githooks/pre-commit
  git rm -q --cached .githooks/pre-push
  stops "フックを消す変更を止める" CHK --staged
  git reset -q
  git mv scripts/check-secrets.sh scripts/old.sh
  stops "検査スクリプトの名前を変える変更を止める" bash scripts/old.sh --staged
  git mv scripts/old.sh scripts/check-secrets.sh
  echo "# comment" >>scripts/claude-hook-bash.sh
  git add scripts/claude-hook-bash.sh
  passes "検査の仕組みの変更は通す" CHK --staged
  out_has "検査の仕組みの変更は警告を出す" "検査の仕組み"
  clean
}

t_cs06() {
  new_repo
  denylist "$WORD" "$WORD_JA" "$WORD_HIRA"
  stage a.txt "by $WORD"
  stops "個人語（そのまま）を止める" CHK --staged
  clean
  stage a.txt "by ${WORD^^}"
  stops "個人語（大文字）を止める" CHK --staged
  clean
  stage a.txt "by $WORD_JA"
  stops "個人語（日本語）を止める" CHK --staged
  clean
  if ((have_py == 0)); then
    skip "表記ゆれ（python3 がない）"
    return
  fi
  local zw=$'\xe2\x80\x8b' cyr_o=$'\xd0\xbe' ideo_sp=$'\xe3\x80\x80'
  stage a.txt "by $(py_conv fullwidth "$WORD")"
  stops "個人語（全角）を止める" CHK --staged
  clean
  stage a.txt "by ${WORD:0:4}$zw${WORD:4}"
  stops "個人語（ゼロ幅スペース入り）を止める" CHK --staged
  clean
  stage a.txt "by ${WORD:0:4}-${WORD:4}"
  stops "個人語（ハイフン入り）を止める" CHK --staged
  clean
  stage a.txt "by ${WORD/o/$cyr_o}"
  stops "個人語（形の似たキリル文字）を止める" CHK --staged
  clean
  stage a.txt "by 架空${ideo_sp}名称"
  stops "個人語（日本語の間に全角空白）を止める" CHK --staged
  clean
  stage a.txt "by 架空 名称"
  stops "個人語（日本語の間に半角空白）を止める" CHK --staged
  clean
  stage a.txt "by $WORD_KATA"
  stops "個人語（ひらがなで登録、カタカナで記載）を止める" CHK --staged
  clean
  py_conv cp932 "名前,$WORD_JA" >sjis.csv
  printf '\n' >>sjis.csv
  git add sjis.csv
  stops "個人語（Shift_JIS の CSV）を止める" CHK --staged
  clean
  py_conv euc_jp "名前 $WORD_JA" >euc.txt
  printf '\n' >>euc.txt
  git add euc.txt
  stops "個人語（EUC-JP）を止める" CHK --staged
  clean
  # Without python3 the plain comparison still runs, and the gap is reported.
  local nopy="$work/nopy"
  mkdir -p "$nopy"
  ln -sf "$(command -v git)" "$nopy/git"
  stage a.txt "by $WORD"
  stops "python3 がなくても個人語（そのまま）は止める" env PATH="$nopy" "$(command -v bash)" "$R/scripts/check-secrets.sh" --staged
  out_has "python3 がないことを伝える" "python3 がない"
  clean
  unset ESM_DENYLIST_FILE
}

t_cs07() {
  new_repo
  local v
  for v in "$MAIL_LOCAL%40$MAIL_DOMAIN" "$MAIL_LOCAL&#64;$MAIL_DOMAIN" "$MAIL_LOCAL＠$MAIL_DOMAIN" \
    "$MAIL_LOCAL [at] $MAIL_DOMAIN" "$MAIL_LOCAL\\u0040$MAIL_DOMAIN"; do
    stage a.txt "mail: $v"
    stops "符号化したメールアドレスを止める (${v:${#MAIL_LOCAL}:4})" CHK --staged
    clean
  done
  if ((have_py == 0)); then
    skip "base64・16 進（python3 がない）"
    return
  fi
  stage a.txt "blob: $(py_conv base64 "$KEY_ANT")"
  stops "base64 にしたキーを止める" CHK --staged
  out_has "base64 を復号したことを伝える" "base64 を復号"
  clean
  stage a.txt "blob: $(py_conv hex "$MAIL")"
  stops "16 進にしたメールアドレスを止める" CHK --staged
  clean
}

t_cs08() {
  new_repo
  local aws40 v
  aws40="$(mixed 40)"
  for v in "password = \"$PW\"" "DB_PASSWORD=$PW" "conn = 'postgres://admin:$PW@10.0.0.5/db'" \
    "Authorization: Bearer $(mixed 30)" "{\"SecretAccessKey\": \"$aws40\"}" \
    "aws-secret-access-key = $aws40" "secret_key = \"$PW\"" \
    "xox""b-1234567890-abcdefghij" "AI""za$(mixed 35)" \
    "ey""J$(mixed 15).ey""J$(mixed 15).$(mixed 15)" "PuTTY-User""-Key-File-3: ssh-ed25519"; do
    stage a.txt "$v"
    stops "規則を足した形を止める: ${v:0:12}…" CHK --staged
    clean
  done
  for v in 'password = "changeme-example"' 'token = os.environ["APP_TOKEN"]' 'password = "${DB_PASSWORD}"' \
    'tokenizer = "bert-base-uncased"' 'password: <your-password>' 'git clone https://github.com/example/repo.git' \
    'url = "https://ci:${CI_TOKEN}@git.example.org/x.git"'; do
    stage a.txt "$v"
    passes "例の値・コードの書き方は通す: ${v:0:12}…" CHK --staged
    clean
  done
}

t_cs09() {
  new_repo
  local f
  for f in .ENV .envrc config/.env.local id_rsa id_ed25519 cert.p12 server.key app.pfx .netrc .npmrc .mcp.json \
    gcp-credentials.json secrets/a.txt; do
    stage "$f" "x"
    stops "ファイル名で止める: $f" CHK --staged
    clean
  done
  for f in .env.example .env.sample .env.template id_rsa.pub docs/key-points.md; do
    stage "$f" "x"
    passes "ファイル名で止めない: $f" CHK --staged
    clean
  done
}

t_cs10() {
  new_repo
  local head
  head=$(remote_main)
  plumb_commit "leak" k.txt "key=$KEY_ANT"
  git update-ref refs/remotes/somefork/x HEAD
  fails "pre-push: 別のリモートの追跡参照にあるコミットも検査する" git push -q origin main
  [[ "$(remote_main)" == "$head" ]] && ok "pre-push: リモートに届いていない" || ng "pre-push: リモートに届いていない"
  git update-ref -d refs/remotes/somefork/x
  fails "pre-push: URL を直接指定したプッシュも検査する" git push -q "$B" main
  git reset -q --hard "$head"

  # A fork that already holds a commit nobody scanned.
  local F="$work/fork$n.git"
  git init -q --bare "$F"
  git checkout -q -b side
  plumb_commit "leak" k.txt "key=$KEY_ANT"
  git --git-dir="$F" fetch -q "$R" side:side
  git checkout -q main
  git branch -q -D side
  git remote add fork "$F"
  git fetch -q fork
  fails "pre-push: フォークから取り込んだコミットも検査する" git push -q origin fork/side:refs/heads/side

  # Replace refs must not hide the real commit (CS-19).
  plumb_commit "leak" k.txt "key=$KEY_ANT"
  local bad clean_c
  bad=$(git rev-parse HEAD)
  clean_c=$(printf 'clean\n' | git commit-tree "$(git rev-parse "$head^{tree}")" -p "$head")
  git replace "$bad" "$clean_c"
  fails "pre-push: git replace で見せかけたコミットも検査する" git push -q origin main
  git replace -d "$bad" >/dev/null
  git reset -q --hard "$head"
  passes "pre-push: 問題のないプッシュは通す" git push -q origin main
}

t_cs13() {
  new_repo
  denylist "$WORD"
  stage "notes/$WORD-memo.md" "x"
  stops "ファイル名の個人語を止める" CHK --staged
  out_lacks "ファイル名の個人語を出力に出さない" "$WORD"
  out_has "ファイル名を伏せたことを伝える" "伏せた"
  clean
  unset ESM_DENYLIST_FILE
  stage "notes/$MAIL.txt" "x"
  stops "ファイル名のメールアドレスを止める" CHK --staged
  out_lacks "ファイル名のメールアドレスを出力に出さない" "$MAIL_LOCAL"
  clean
}

t_cs15() {
  new_repo
  local start
  head -c 300000 /dev/zero | tr '\0' 'a' >long.txt
  printf '\n' >>long.txt
  git add long.txt
  start=$SECONDS
  passes "30 万文字の 1 行を通す" CHK --staged
  if ((SECONDS - start <= 30)); then ok "30 万文字の 1 行が 30 秒以内（$((SECONDS - start)) 秒）"; else ng "30 万文字の 1 行が 30 秒以内（$((SECONDS - start)) 秒）"; fi
  clean
  { head -c 100000 /dev/zero | tr '\0' 'b'; printf ' %s ' "$KEY_ANT"; head -c 100000 /dev/zero | tr '\0' 'c'; printf '\n'; } >long.txt
  git add long.txt
  stops "長い行の途中のキーを止める" CHK --staged
  clean
}

t_cs16() {
  new_repo
  stops "--require-denylist: 禁止語リストがなければ止める" CHK --all --require-denylist
  denylist "$WORD"
  passes "--require-denylist: 禁止語リストがあれば通す" CHK --all --require-denylist
  out_has "個人語の検査を実施したと伝える" "個人語の検査を実施"
  unset ESM_DENYLIST_FILE
}

t_cs19() {
  local R2="$work/root$n"
  git init -q -b main "$R2"
  (
    cd "$R2" || exit 1
    printf '%s\n' "key=$KEY_ANT" >k.txt
    git add k.txt
    c=$(printf 'root\n' | git commit-tree "$(git write-tree)")
    git update-ref refs/heads/main "$c"
    git config log.showRoot false
  )
  cd "$R2" || return
  stops "log.showRoot=false でも最初のコミットを検査する" bash "$root/scripts/check-secrets.sh" --range 0 HEAD
  cd "$work" || return
}

t_cs20() {
  new_repo
  printf '%s\n' "$WORD" >"$R/inside.txt"
  ln -s "$R/inside.txt" "$work/link-denylist.txt"
  export ESM_DENYLIST_FILE="$work/link-denylist.txt"
  stops "禁止語リストのシンボリックリンクを止める" CHK --staged
  export ESM_DENYLIST_FILE="$R/inside.txt"
  stops "リポジトリ内の禁止語リストを止める" CHK --staged
  unset ESM_DENYLIST_FILE
  rm -f "$R/inside.txt" "$work/link-denylist.txt"
}

t_all() {
  new_repo
  passes "--all: 問題のない履歴は通す" CHK --all
  git checkout -q -b side
  plumb_commit "leak" k.txt "key=$KEY_ANT"
  git checkout -q main
  stops "--all: 取り出していないブランチのキーも止める" CHK --all
  git branch -q -D side
  passes "--all: ブランチを消せば通す" CHK --all
  git tag -a v1 -m "by $MAIL"
  stops "--all: 注釈付きタグのメッセージも止める" CHK --all
  git tag -d v1 >/dev/null
  denylist "$WORD"
  git branch "topic-$WORD"
  stops "--all: 参照名の個人語も止める" CHK --all
  out_lacks "--all: 参照名を出力に出さない" "$WORD"
  git branch -q -D "topic-$WORD"
  unset ESM_DENYLIST_FILE
  plumb_commit "Merge topic" m.txt "ok"
  GIT_AUTHOR_EMAIL="$MAIL" plumb_commit "normal" m2.txt "ok"
  stops "--all: 作成者のメールアドレスも止める" CHK --all
}

groups=(basic cs01 cs02 cs03 cs04 cs05 cs06 cs07 cs08 cs09 cs10 cs13 cs15 cs16 cs19 cs20 all)
if (($# > 0)); then groups=("$@"); fi
for g in "${groups[@]}"; do
  if ! declare -F "t_$g" >/dev/null; then
    echo "unknown group: $g" >&2
    exit 1
  fi
  printf '== %s\n' "$g"
  "t_$g"
  cd "$work" || exit 1
done

printf '\n合格 %d・失敗 %d・省略 %d\n' "$passed" "$failed" "$skipped"
((failed == 0))
