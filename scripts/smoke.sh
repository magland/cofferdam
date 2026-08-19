#!/usr/bin/env bash
# End-to-end smoke test: starts a server on a fresh vault and exercises
# browsing, sessions, UI operations, the JSON API, and git over HTTP.
# Run from the repository root: bash scripts/smoke.sh
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${SMOKE_PORT:-$((RANDOM % 2000 + 42000))}"
BASE="http://127.0.0.1:$PORT"
# The credential checks below assert that git's store wrote 0600, so the
# scratch tree has to sit on a filesystem that can actually keep a file
# private. In some containers /tmp cannot: a file created under umask 077
# comes back 646, and the assertion fails for a reason that has nothing to do
# with hubbit. Probe, and fall back rather than making the check weaker.
smoke_tmp() {
  local base d mode
  for base in "${TMPDIR:-/tmp}" /dev/shm; do
    [ -d "$base" ] && [ -w "$base" ] || continue
    d="$(mktemp -d "$base/hubbit-smoke.XXXXXX" 2>/dev/null)" || continue
    ( umask 077; : > "$d/probe" )
    mode="$(stat -c '%a' "$d/probe" 2>/dev/null || stat -f '%Lp' "$d/probe")"
    rm -f "$d/probe"
    if [ "$mode" = 600 ]; then printf '%s\n' "$d"; return 0; fi
    rm -rf "$d"
  done
  echo "no writable directory that can hold a 0600 file (tried \$TMPDIR and /dev/shm); set TMPDIR to one" >&2
  return 1
}
TMP="$(smoke_tmp)"
VAULT="$TMP/vault"
LOG="$TMP/server.log"
JAR="$TMP/owner.jar"
ALICE_JAR="$TMP/alice.jar"
BODY="$TMP/body"
mkdir -p "$VAULT"

export GIT_TERMINAL_PROMPT=0

# The suite tests hubbit, not the machine's git configuration, and two of the
# checks below are only meaningful against a known one: "login refuses when no
# credential helper is configured" is false the moment a system config sets a
# helper, as a hosted development container does. An identity has to come from
# somewhere too, since several commits here do not pass one.
export GIT_CONFIG_SYSTEM=/dev/null
export GIT_CONFIG_GLOBAL="$TMP/gitconfig"
cat > "$GIT_CONFIG_GLOBAL" <<'GITCONFIG'
[user]
	name = hubbit smoke
	email = smoke@example.invalid
[init]
	defaultBranch = main
GITCONFIG

# tsc writes its diagnostics to stdout, so discarding stdout here used to turn
# "HEAD does not compile" into a suite that exited 2 having printed nothing at
# all. Keep the output and show it: the build failing is the most useful thing
# this script can tell you, not the least.
if ! npm run build > "$TMP/build.log" 2>&1; then
  echo "FAIL: the build failed, so none of the checks below ran"
  cat "$TMP/build.log"
  exit 1
fi

SERVER_PID=""
FORGE_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "$FORGE_PID" ] && kill "$FORGE_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

node dist/index.js serve "$VAULT" --port "$PORT" > "$LOG" 2>&1 &
SERVER_PID=$!

started=0
for _ in $(seq 1 50); do
  if curl -s -o /dev/null "$BASE/"; then started=1; break; fi
  sleep 0.2
done
if [ "$started" != 1 ]; then
  echo "FAIL: server did not start"; cat "$LOG"; exit 1
fi

OWNER_TOKEN="$(grep -o 'hubbit_[0-9a-f]\{64\}' "$LOG" | head -1 || true)"
[ -n "$OWNER_TOKEN" ] || { echo "FAIL: no owner token in server log"; cat "$LOG"; exit 1; }

PASS=0
check() {
  local desc="$1" want="$2"; shift 2
  local got
  got="$(curl -sS -o "$BODY" -w '%{http_code}' "$@")"
  if [ "$got" != "$want" ]; then
    echo "FAIL: $desc (want HTTP $want, got $got)"
    head -c 2000 "$BODY"; echo; exit 1
  fi
  PASS=$((PASS+1)); echo "ok: $desc"
}
body_has() {
  local desc="$1" pattern="$2"
  grep -q -e "$pattern" "$BODY" || { echo "FAIL: $desc (pattern not found: $pattern)"; head -c 2000 "$BODY"; echo; exit 1; }
  PASS=$((PASS+1)); echo "ok: $desc"
}
body_lacks() {
  local desc="$1" pattern="$2"
  if grep -q -e "$pattern" "$BODY"; then echo "FAIL: $desc (pattern unexpectedly found: $pattern)"; exit 1; fi
  PASS=$((PASS+1)); echo "ok: $desc"
}
csrf_of() { { grep -o 'name="csrf" value="[^"]*"' "$BODY" || true; } | head -1 | sed 's/.*value="//;s/"$//'; }
expected_of() { { grep -o 'name="expected" value="[^"]*"' "$BODY" || true; } | head -1 | sed 's/.*value="//;s/"$//'; }

# ---- anonymous browsing and auth walls ----

check "home page" 200 "$BASE/"
check "login form" 200 "$BASE/login"
check "bad login rejected" 401 "$BASE/login" --data-urlencode username=owner --data-urlencode token=wrong
check "anonymous /new redirects to login" 302 "$BASE/new"
check "anonymous POST /new forbidden" 403 -X POST "$BASE/new"

# ---- sign in as owner ----

check "owner login" 302 -c "$JAR" "$BASE/login" \
  --data-urlencode username=owner --data-urlencode "token=$OWNER_TOKEN" --data-urlencode next=/
check "home shows signed-in user" 200 -b "$JAR" "$BASE/"
body_has "username in header" '>owner<'
body_has "new repository button" 'New repository'

# ---- create a repository from the UI ----

check "new repo form" 200 -b "$JAR" "$BASE/new"
CSRF="$(csrf_of)"
[ -n "$CSRF" ] || { echo "FAIL: no csrf on /new"; exit 1; }
check "create demo/proj" 302 -b "$JAR" "$BASE/new" \
  --data-urlencode "csrf=$CSRF" --data-urlencode collection=demo --data-urlencode name=proj \
  --data-urlencode "description=Demo project" --data-urlencode init=1
check "repo page renders" 200 -b "$JAR" "$BASE/demo/proj"
body_has "README rendered" 'Demo project'
body_has "settings tab shown" '>Settings<'
body_has "clone menu present" 'Clone with HTTP'
body_has "clone menu carries the URL" "value=\"$BASE/demo/proj\""
body_lacks "no collapsible cli hints" 'cmd-hint'
body_has "go to file button" 'data-find-url'

# ---- the file finder ----

check "file finder" 200 -b "$JAR" "$BASE/demo/proj/find/main"
body_has "finder lists a file" 'class="find-item" href="/demo/proj/blob/main/README.md"'
check "file finder without a ref" 200 -b "$JAR" "$BASE/demo/proj/find"
body_has "finder defaults to the default branch" 'href="/demo/proj/blob/main/README.md"'
check "file finder at a missing ref" 404 -b "$JAR" "$BASE/demo/proj/find/nosuchbranch"

check "csrf rejected on POST" 403 -b "$JAR" "$BASE/demo/proj/branches/create" \
  --data-urlencode csrf=bogus --data-urlencode name=x

# ---- edit a file ----

check "edit form" 200 -b "$JAR" "$BASE/demo/proj/edit/main/README.md"
CSRF="$(csrf_of)"; EXPECTED="$(expected_of)"
[ -n "$EXPECTED" ] || { echo "FAIL: no expected sha on edit form"; exit 1; }
check "commit edit" 302 -b "$JAR" "$BASE/demo/proj/edit/main/README.md" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "expected=$EXPECTED" \
  --data-urlencode "content=# proj

Edited via the web interface.
" --data-urlencode "message=Edit README from the web"
check "blob shows the edit" 200 -b "$JAR" "$BASE/demo/proj/blob/main/README.md"
body_has "edited content" 'Edited via the web interface'
check "stale edit conflicts" 409 -b "$JAR" "$BASE/demo/proj/edit/main/README.md" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "expected=$EXPECTED" \
  --data-urlencode "content=clobber" --data-urlencode "message=stale"
check "commit history shows web commit" 200 -b "$JAR" "$BASE/demo/proj/commits/main"
body_has "web commit subject" 'Edit README from the web'
body_has "web commit author" 'owner committed'
WEB_SHA="$({ grep -o 'commit/[0-9a-f]\{40\}' "$BODY" || true; } | head -1 | sed 's|commit/||')"
[ -n "$WEB_SHA" ] || { echo "FAIL: no commit sha on the commits page"; exit 1; }
check "commit diff page" 200 -b "$JAR" "$BASE/demo/proj/commit/$WEB_SHA"
body_has "diff shows the edit" 'Edited via the web interface'
body_has "diff counts the changed files" 'changed file'
body_has "diff numbers its lines" 'class="dnum"'
body_has "diff offers the whole file" 'View file'
body_lacks "no diff header noise" 'index 0000000'
body_lacks "no hints on commit page" 'cmd-hint'

# ---- create and delete a file ----

check "new file form" 200 -b "$JAR" "$BASE/demo/proj/new/main"
CSRF="$(csrf_of)"; EXPECTED="$(expected_of)"
check "create docs/notes.md" 302 -b "$JAR" "$BASE/demo/proj/new/main" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "expected=$EXPECTED" \
  --data-urlencode filename=docs/notes.md --data-urlencode "content=Some notes." \
  --data-urlencode "message="
check "created file renders" 200 -b "$JAR" "$BASE/demo/proj/blob/main/docs/notes.md"
body_has "created file content" 'Some notes.'
check "duplicate create rejected" 200 -b "$JAR" "$BASE/demo/proj/new/main"
CSRF="$(csrf_of)"; EXPECTED="$(expected_of)"
check "duplicate create is an error" 400 -b "$JAR" "$BASE/demo/proj/new/main" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "expected=$EXPECTED" \
  --data-urlencode filename=docs/notes.md --data-urlencode content=dup --data-urlencode message=dup

check "delete confirm form" 200 -b "$JAR" "$BASE/demo/proj/delete/main/docs/notes.md"
CSRF="$(csrf_of)"; EXPECTED="$(expected_of)"
check "delete the file" 302 -b "$JAR" "$BASE/demo/proj/delete/main/docs/notes.md" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "expected=$EXPECTED" --data-urlencode "message="
check "deleted file is gone" 404 -b "$JAR" "$BASE/demo/proj/blob/main/docs/notes.md"

# ---- import page ----

check "import page needs a session" 302 "$BASE/import"
check "import page" 200 -b "$JAR" "$BASE/import"
body_has "import form" 'name="src"'
check "import command for a github url" 200 -b "$JAR" \
  --get "$BASE/import" --data-urlencode "src=https://github.com/octocat/Hello-World" --data-urlencode collection=demo
body_has "clone is bare, not mirror" 'git clone --bare https://github.com/octocat/Hello-World'
# The clone is scratch: it must not land in whatever directory the command is
# pasted into, which is how a failed attempt leaves a bare repo in a work tree.
body_has "clone goes to a temporary directory" 'mktemp -d /tmp/import'
body_lacks "nothing is cloned into the current directory" 'Hello-World.import.git'
body_has "push is a mirror push" 'push --mirror'
# Without this the prompt goes to an editor's askpass dialog, and an unanswered
# dialog looks like a hang: git prints nothing after the clone and waits.
body_has "push prompts in the terminal" 'GIT_ASKPASS= git -C'
body_has "a way back to the collection" 'href="/demo">Back to demo'
body_has "destination carries the username" "owner@"
body_lacks "no mirror clone" 'clone --mirror'
check "import command from owner/repo shorthand" 200 -b "$JAR" \
  --get "$BASE/import" --data-urlencode src=octocat/Hello-World --data-urlencode collection=demo
body_has "shorthand expands to github" 'https://github.com/octocat/Hello-World.git'
check "shell metacharacters refused" 400 -b "$JAR" \
  --get "$BASE/import" --data-urlencode "src=https://github.com/a/b; rm -rf ~" --data-urlencode collection=demo
check "non-git scheme refused" 400 -b "$JAR" \
  --get "$BASE/import" --data-urlencode "src=file:///etc/passwd" --data-urlencode collection=demo
check "existing repo refused" 409 -b "$JAR" \
  --get "$BASE/import" --data-urlencode src=octocat/proj --data-urlencode collection=demo
check "import is a reserved repo name" 400 -b "$JAR" "$BASE/new" \
  --data-urlencode "csrf=$CSRF" --data-urlencode collection=demo --data-urlencode name=import

# ---- markdown rendering ----

MD_DOC="$(cat <<'EOF'
# Guide

A [link to the readme](../README.md) and a [section link](#guide).

```ts
interface Config { root: string }
```
EOF
)"

check "new markdown form" 200 -b "$JAR" "$BASE/demo/proj/new/main"
CSRF="$(csrf_of)"; EXPECTED="$(expected_of)"
check "create docs/guide.md" 302 -b "$JAR" "$BASE/demo/proj/new/main" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "expected=$EXPECTED" \
  --data-urlencode filename=docs/guide.md --data-urlencode "content=$MD_DOC" \
  --data-urlencode "message=Add guide"
check "markdown blob renders" 200 -b "$JAR" "$BASE/demo/proj/blob/main/docs/guide.md"
body_has "rendered markdown body" 'class="rendered markdown-body"'
body_has "heading anchor id" '<h1 id="guide">'
body_has "relative link resolved against the file directory" 'href="/demo/proj/blob/main/README.md"'
body_has "anchor link left alone" 'href="#guide"'
body_has "fenced code highlighted" 'hljs-keyword'
body_has "source view offered" 'docs/guide.md?plain=1'
body_lacks "no numbered lines in the preview" 'class="lnum"'
check "markdown source view" 200 -b "$JAR" "$BASE/demo/proj/blob/main/docs/guide.md?plain=1"
body_has "source view numbers its lines" 'class="lnum"'
body_has "source view shows the markup" '# Guide'
body_lacks "source view is not rendered" 'class="rendered markdown-body"'
check "repo home renders the readme" 200 "$BASE/demo/proj"
body_has "readme box links to the file" 'href="/demo/proj/blob/main/README.md">README.md'

RICH_DOC="$(cat <<'EOF'
# Rich

Inline $E = mc^2$ and display math:

$$
\int_0^1 x^2\,dx
$$

> [!WARNING]
> Careful with this.

- [x] done
- [ ] todo

Emoji :tada: and a footnote[^a].

[^a]: Footnote body.

<script>window.pwned = 'XSSMARK'</script>
<img src="x" onerror="XSSMARK" alt="an image">
<iframe src="https://example.org"></iframe>
<div style="position:fixed;top:0">overlay</div>
<a href="javascript:XSSMARK">first link</a>
<a href="https://example.org" onclick="XSSMARK">second link</a>
<details><summary>More</summary>hidden text</details>
EOF
)"

check "new rich markdown form" 200 -b "$JAR" "$BASE/demo/proj/new/main"
CSRF="$(csrf_of)"; EXPECTED="$(expected_of)"
check "create docs/rich.md" 302 -b "$JAR" "$BASE/demo/proj/new/main" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "expected=$EXPECTED" \
  --data-urlencode filename=docs/rich.md --data-urlencode "content=$RICH_DOC" \
  --data-urlencode "message=Add rich document"
check "rich markdown renders" 200 -b "$JAR" "$BASE/demo/proj/blob/main/docs/rich.md"
body_has "inline math rendered" 'class="katex"'
body_has "display math rendered" 'class="math-block"'
body_has "alert callout" 'alert alert-warning'
body_has "alert title" 'Warning</p>'
body_has "task list checkbox" 'type="checkbox" disabled checked'
body_has "task list item class" 'task-item'
body_has "footnote section" 'footnotes-list'
body_has "emoji shortcode" '🎉'
body_has "heading anchor" 'class="heading-anchor"'
body_has "details kept" '<details>'
body_has "external link gets rel" 'rel="nofollow noopener noreferrer"'
body_lacks "scripts and handlers stripped" 'XSSMARK'
body_lacks "inline styles stripped" 'position:fixed'
body_lacks "frames stripped" '<iframe'

check "katex stylesheet" 200 "$BASE/assets/katex/katex.css"
check "katex font" 200 "$BASE/assets/katex/fonts/KaTeX_Main-Regular.woff2"
check "katex font names are fixed" 404 "$BASE/assets/katex/fonts/anything-else.woff2"

check "new text file form" 200 -b "$JAR" "$BASE/demo/proj/new/main"
CSRF="$(csrf_of)"; EXPECTED="$(expected_of)"
check "create docs/plain.txt" 302 -b "$JAR" "$BASE/demo/proj/new/main" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "expected=$EXPECTED" \
  --data-urlencode filename=docs/plain.txt --data-urlencode "content=# not markdown" \
  --data-urlencode "message="
check "text file shows source" 200 -b "$JAR" "$BASE/demo/proj/blob/main/docs/plain.txt"
body_has "text file numbers its lines" 'class="lnum"'
body_lacks "no preview toggle on a text file" 'plain=1'

# ---- language breakdown ----

# Only programming and markup count, as Linguist counts them, so the repo as
# it stands (readme, markdown, a text file) reports no languages at all.
check "repo home before any source" 200 "$BASE/demo/proj"
body_lacks "no languages for a tree of documents" 'lang-bar'

check "new source file form" 200 -b "$JAR" "$BASE/demo/proj/new/main"
CSRF="$(csrf_of)"; EXPECTED="$(expected_of)"
check "create src/app.ts" 302 -b "$JAR" "$BASE/demo/proj/new/main" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "expected=$EXPECTED" \
  --data-urlencode filename=src/app.ts --data-urlencode "content=export const app = 'hello';" \
  --data-urlencode "message=Add a source file"
check "repo home with source" 200 "$BASE/demo/proj"
body_has "languages block" '<h3>Languages</h3>'
body_has "language bar drawn" 'class="lang-seg"'
body_has "language named" '>TypeScript<'
body_has "language share shown" 'class="lang-pct'
# The tree is read once, at the root, which is the only place the About panel
# that carries the bar appears.
check "subdirectory listing" 200 "$BASE/demo/proj/tree/main/src"
body_lacks "no languages away from the root" 'lang-bar'

# ---- branches and tags ----

check "branches page" 200 -b "$JAR" "$BASE/demo/proj/branches"
CSRF="$(csrf_of)"
check "create branch" 302 -b "$JAR" "$BASE/demo/proj/branches/create" \
  --data-urlencode "csrf=$CSRF" --data-urlencode name=feature --data-urlencode from=main
check "branch listed" 200 -b "$JAR" "$BASE/demo/proj/branches"
body_has "feature branch shown" '>feature<'
body_has "branch row offers a comparison" 'compare/main...feature'

# ---- comparing two revisions ----

check "compare form" 200 "$BASE/demo/proj/compare"
body_has "compare offers both revisions" 'name="head"'
check "compare a branch with itself" 200 "$BASE/demo/proj/compare/main...feature"
body_has "identical revisions say so" 'identical'
check "compare with two dots" 200 "$BASE/demo/proj/compare/main..feature"
check "compare with an unknown revision 404s" 404 "$BASE/demo/proj/compare/main...no-such-ref"
check "default branch delete refused" 400 -b "$JAR" "$BASE/demo/proj/branches/delete" \
  --data-urlencode "csrf=$CSRF" --data-urlencode name=main
check "delete branch" 302 -b "$JAR" "$BASE/demo/proj/branches/delete" \
  --data-urlencode "csrf=$CSRF" --data-urlencode name=feature
check "tag create" 302 -b "$JAR" "$BASE/demo/proj/tags/create" \
  --data-urlencode "csrf=$CSRF" --data-urlencode name=v1.0.0 --data-urlencode at=main
check "tag listed" 200 -b "$JAR" "$BASE/demo/proj/tags"
body_has "tag shown" 'v1.0.0'
check "tag delete" 302 -b "$JAR" "$BASE/demo/proj/tags/delete" \
  --data-urlencode "csrf=$CSRF" --data-urlencode name=v1.0.0

# ---- issues ----

check "issues tab on the repo page" 200 -b "$JAR" "$BASE/demo/proj"
body_has "issues tab present" '/demo/proj/issues"'
check "empty issue list" 200 "$BASE/demo/proj/issues"
body_has "empty issue list says so" 'No open issues'
check "anonymous new issue redirects to login" 302 "$BASE/demo/proj/issues/new"
check "new issue form" 200 -b "$JAR" "$BASE/demo/proj/issues/new"
CSRF="$(csrf_of)"
check "issue needs a title" 400 -b "$JAR" "$BASE/demo/proj/issues/new" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "title=  " --data-urlencode "body=nothing"
check "open an issue" 302 -b "$JAR" "$BASE/demo/proj/issues/new" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "title=Something is wrong" \
  --data-urlencode "body=It **breaks** on startup." --data-urlencode "labels=bug, ui"
check "issue page" 200 "$BASE/demo/proj/issues/1"
body_has "issue title" 'Something is wrong'
body_has "issue body is rendered markdown" '<strong>breaks</strong>'
body_has "issue carries its labels" '>bug<'
body_has "issue is open" 'Open'
check "issue list shows it" 200 "$BASE/demo/proj/issues"
body_has "list links the issue" 'href="/demo/proj/issues/1"'
check "anonymous cannot comment" 403 "$BASE/demo/proj/issues/1/comment" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "body=hello"
check "csrf is checked on comments" 403 -b "$JAR" "$BASE/demo/proj/issues/1/comment" \
  --data-urlencode "csrf=bogus" --data-urlencode "body=hello"
check "comment on an issue" 302 -b "$JAR" "$BASE/demo/proj/issues/1/comment" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "body=I see it too"
check "comment shows on the issue" 200 "$BASE/demo/proj/issues/1"
body_has "comment body" 'I see it too'
check "edit an issue" 302 -b "$JAR" "$BASE/demo/proj/issues/1/edit" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "title=Something is still wrong" \
  --data-urlencode "body=It breaks on startup." --data-urlencode "labels=bug"
check "close an issue" 302 -b "$JAR" "$BASE/demo/proj/issues/1/state" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "state=closed" --data-urlencode "body=Fixed on main"
check "closed issues listed" 200 "$BASE/demo/proj/issues?state=closed"
body_has "closed issue named" 'Something is still wrong'
check "open list is empty again" 200 "$BASE/demo/proj/issues"
body_has "no open issues left" 'No open issues'
check "closing comment kept" 200 "$BASE/demo/proj/issues/1"
body_has "the comment posted with the close" 'Fixed on main'
check "reopen an issue" 302 -b "$JAR" "$BASE/demo/proj/issues/1/state" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "state=open"
check "issue is open again" 200 "$BASE/demo/proj/issues/1"
body_has "open badge" 'state-badge open'
check "cross-reference in an issue" 302 -b "$JAR" "$BASE/demo/proj/issues/new" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "title=Follows on from the first" \
  --data-urlencode "body=Same as #1, and introduced by 0123abcdef0123abcdef0123abcdef0123abcdef. Not this: 1234567."
check "cross-referenced issue page" 200 "$BASE/demo/proj/issues/2"
body_has "issue reference became a link" 'href="/demo/proj/issues/1"'
body_has "commit id became a link" 'href="/demo/proj/commit/0123abcdef0123abcdef0123abcdef0123abcdef"'
body_has "commit id shown abbreviated" '>0123abc<'
body_lacks "a plain number is not a commit" 'commit/1234567'
check "unknown issue 404s" 404 "$BASE/demo/proj/issues/99"
check "non-numeric issue 404s" 404 "$BASE/demo/proj/issues/nope"
ISSUE_FILE="$VAULT/demo/proj.issues/1/issue.md"
[ -f "$ISSUE_FILE" ] || { echo "FAIL: issue not on disk at $ISSUE_FILE"; exit 1; }
grep -q '^title: Something is still wrong$' "$ISSUE_FILE" || { echo "FAIL: issue file has no title header"; exit 1; }
[ -f "$VAULT/demo/proj.issues/1/comments/1.md" ] || { echo "FAIL: comment not on disk"; exit 1; }
PASS=$((PASS+3)); echo "ok: issues are files in the vault"

# ---- settings ----

check "settings page" 200 -b "$JAR" "$BASE/demo/proj/settings"
CSRF="$(csrf_of)"
check "save settings" 302 -b "$JAR" "$BASE/demo/proj/settings" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "description=A refreshed description" \
  --data-urlencode defaultBranch=main
check "collection page shows description" 200 "$BASE/demo"
body_has "description updated" 'A refreshed description'

# ---- renaming and moving a repository ----

check "settings page again" 200 -b "$JAR" "$BASE/demo/proj/settings"
body_has "settings offers a rename" 'settings/rename'
check "rename the repository" 302 -b "$JAR" "$BASE/demo/proj/settings/rename" \
  --data-urlencode "csrf=$CSRF" --data-urlencode collection=demo --data-urlencode name=renamed
check "the new name serves the repository" 200 "$BASE/demo/renamed"
check "the old name is gone" 404 "$BASE/demo/proj"
check "issues moved with it" 200 "$BASE/demo/renamed/issues?state=all"
body_has "the moved issue is there" 'Something is still wrong'
check "a repository to collide with" 302 -b "$JAR" "$BASE/new" \
  --data-urlencode "csrf=$CSRF" --data-urlencode collection=demo --data-urlencode name=taken --data-urlencode init=1
check "moving onto an existing repository is refused" 409 -b "$JAR" "$BASE/demo/renamed/settings/rename" \
  --data-urlencode "csrf=$CSRF" --data-urlencode collection=demo --data-urlencode name=taken
check "renaming to its own name is refused" 400 -b "$JAR" "$BASE/demo/renamed/settings/rename" \
  --data-urlencode "csrf=$CSRF" --data-urlencode collection=demo --data-urlencode name=renamed
check "move to another collection" 302 -b "$JAR" "$BASE/demo/renamed/settings/rename" \
  --data-urlencode "csrf=$CSRF" --data-urlencode collection=moved --data-urlencode name=proj
check "the repository is in the new collection" 200 "$BASE/moved/proj"
[ -d "$VAULT/moved/proj.issues" ] || { echo "FAIL: issues did not move to the new collection"; exit 1; }
[ -d "$VAULT/demo/proj.issues" ] && { echo "FAIL: issues left behind in the old collection"; exit 1; }
PASS=$((PASS+2)); echo "ok: the issue directory moved with the repository"
check "move it back" 302 -b "$JAR" "$BASE/moved/proj/settings/rename" \
  --data-urlencode "csrf=$CSRF" --data-urlencode collection=demo --data-urlencode name=proj
check "back at its old address" 200 "$BASE/demo/proj"

# ---- empty repository README flow ----

check "new repo form again" 200 -b "$JAR" "$BASE/new"
CSRF="$(csrf_of)"
check "create demo/bare without init" 302 -b "$JAR" "$BASE/new" \
  --data-urlencode "csrf=$CSRF" --data-urlencode collection=demo --data-urlencode name=bare
check "empty repo page" 200 -b "$JAR" "$BASE/demo/bare"
body_has "create README button" 'Create a README'
body_has "empty repo shows the remote command" 'git remote add origin'
body_has "empty repo keeps push command" 'git push -u origin main'
check "new file form on empty repo" 200 -b "$JAR" "$BASE/demo/bare/new/main"
CSRF="$(csrf_of)"
check "first commit via web" 302 -b "$JAR" "$BASE/demo/bare/new/main" \
  --data-urlencode "csrf=$CSRF" --data-urlencode expected= \
  --data-urlencode filename=README.md --data-urlencode "content=# bare" --data-urlencode message=
check "empty repo now has content" 200 -b "$JAR" "$BASE/demo/bare"
body_has "readme committed" 'README.md'

# ---- user administration ----

check "admin users page" 200 -b "$JAR" "$BASE/admin/users"
CSRF="$(csrf_of)"
check "create user alice" 200 -b "$JAR" "$BASE/admin/users" \
  --data-urlencode "csrf=$CSRF" --data-urlencode username=alice --data-urlencode "scope=demo/*" \
  --data-urlencode "admin="
ALICE_TOKEN="$(grep -o 'hubbit_[0-9a-f]\{64\}' "$BODY" | head -1 || true)"
[ -n "$ALICE_TOKEN" ] || { echo "FAIL: no token for alice shown"; exit 1; }
check "grant to alice" 302 -b "$JAR" "$BASE/admin/users/alice/grant" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "scope=extra/thing" --data-urlencode "admin="
check "mint token for alice" 200 -b "$JAR" "$BASE/admin/users/alice/token" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "tokenScope="
body_has "minted token shown" 'hubbit_'

# ---- themes ----

check "default theme is not github" 200 "$BASE/"
body_has "default theme linked" 'style.css?t=paper'
check "themed stylesheet" 200 "$BASE/assets/style.css?t=paper"
body_has "theme variables emitted" '--accent:'
body_lacks "no hardcoded github blue in structure" '#0969da'
check "highlight stylesheet follows the theme" 200 "$BASE/assets/hl.css?t=paper"

check "admin index" 200 -b "$JAR" "$BASE/admin"
body_has "appearance card" 'Appearance'
check "appearance page" 200 -b "$JAR" "$BASE/admin/appearance"
CSRF="$(csrf_of)"
body_has "github theme offered" 'value="github"'
check "unknown theme refused" 400 -b "$JAR" "$BASE/admin/appearance" \
  --data-urlencode "csrf=$CSRF" --data-urlencode theme=nonesuch
check "switch to github theme" 302 -b "$JAR" "$BASE/admin/appearance" \
  --data-urlencode "csrf=$CSRF" --data-urlencode theme=github
check "pages now use github theme" 200 "$BASE/"
body_has "github theme linked" 'style.css?t=github'
check "github stylesheet has github blue" 200 "$BASE/assets/style.css"
body_has "github accent value" '#0969da'
grep -q '"theme": "github"' "$VAULT/config.json" || { echo "FAIL: theme not persisted to config.json"; exit 1; }
PASS=$((PASS+1)); echo "ok: theme persisted to config.json"

# A hand-edited config.json is picked up without a restart.
printf '{\n  "theme": "midnight"\n}\n' > "$VAULT/config.json"
check "hand-edited theme applies" 200 "$BASE/"
body_has "midnight theme linked" 'style.css?t=midnight'
printf '{\n  "theme": "bogus-theme"\n}\n' > "$VAULT/config.json"
check "invalid theme falls back" 200 "$BASE/"
body_has "fallback to default" 'style.css?t=paper'
printf '{\n  "theme": "paper"\n}\n' > "$VAULT/config.json"

# ---- alice's limited abilities ----

check "alice login" 302 -c "$ALICE_JAR" "$BASE/login" \
  --data-urlencode username=alice --data-urlencode "token=$ALICE_TOKEN" --data-urlencode next=/
check "alice cannot see admin" 403 -b "$ALICE_JAR" "$BASE/admin/users"
check "alice can open edit in scope" 200 -b "$ALICE_JAR" "$BASE/demo/proj/edit/main/README.md"
ALICE_CSRF="$(csrf_of)"
check "alice cannot create out of scope" 403 -b "$ALICE_JAR" "$BASE/new" \
  --data-urlencode "csrf=$ALICE_CSRF" --data-urlencode collection=other --data-urlencode name=x
check "alice cannot rename repo" 403 -b "$ALICE_JAR" "$BASE/demo/proj/settings/rename" \
  --data-urlencode "csrf=$ALICE_CSRF" --data-urlencode collection=demo --data-urlencode name=nope
check "alice cannot delete repo" 403 -b "$ALICE_JAR" "$BASE/demo/proj/settings/delete" \
  --data-urlencode "csrf=$ALICE_CSRF" --data-urlencode confirm=demo/proj
check "alice cannot import out of scope" 403 -b "$ALICE_JAR" \
  --get "$BASE/import" --data-urlencode src=octocat/Hello-World --data-urlencode collection=other

# ---- a delegated collection admin is an admin, but not for vault-wide settings ----

check "admin users page for delegation" 200 -b "$JAR" "$BASE/admin/users"
CSRF="$(csrf_of)"
check "create delegated admin" 200 -b "$JAR" "$BASE/admin/users" \
  --data-urlencode "csrf=$CSRF" --data-urlencode username=collectionadmin \
  --data-urlencode "scope=demo/*" --data-urlencode "admin=demo/*"
COLLECTION_TOKEN="$(grep -o 'hubbit_[0-9a-f]\{64\}' "$BODY" | head -1 || true)"
[ -n "$COLLECTION_TOKEN" ] || { echo "FAIL: no token for collectionadmin"; exit 1; }
check "collectionadmin login" 302 -c "$TMP/collectionadmin.jar" "$BASE/login" \
  --data-urlencode username=collectionadmin --data-urlencode "token=$COLLECTION_TOKEN" --data-urlencode next=/
check "collectionadmin reaches admin index" 200 -b "$TMP/collectionadmin.jar" "$BASE/admin"
body_lacks "no appearance card for delegated admin" '/admin/appearance'
check "collectionadmin cannot open appearance" 403 -b "$TMP/collectionadmin.jar" "$BASE/admin/appearance"
check "collectionadmin cannot set the theme" 403 -b "$TMP/collectionadmin.jar" "$BASE/admin/appearance" \
  --data-urlencode "csrf=$CSRF" --data-urlencode theme=terminal

# ---- anonymous sees no controls ----

check "anonymous repo page" 200 "$BASE/demo/proj"
body_lacks "no settings tab for anonymous" '>Settings<'
body_lacks "no add-file button for anonymous" '>Add file<'
check "anonymous blob page" 200 "$BASE/demo/proj/blob/main/README.md"
body_lacks "no edit button for anonymous" '>Edit<'

# ---- raw serving policy ----

check "raw file" 200 -D "$TMP/headers" "$BASE/demo/proj/raw/main/README.md"
grep -qi 'content-security-policy: sandbox' "$TMP/headers" || { echo "FAIL: raw CSP header missing"; exit 1; }
grep -qi 'content-type: text/plain' "$TMP/headers" || { echo "FAIL: raw content-type not text/plain"; exit 1; }
PASS=$((PASS+2)); echo "ok: raw CSP and content-type"

# ---- contributors, and history by author ----

check "repo home lists contributors" 200 "$BASE/demo/proj"
body_has "contributors block" '<h3>Contributors'
body_has "contributor links to their commits" 'commits/main?author='
check "history filtered by author" 200 --get "$BASE/demo/proj/commits/main" --data-urlencode "author=owner@example.org"
body_has "author filter is shown" 'class="filter-chip"'
check "history by an author with no commits" 200 --get "$BASE/demo/proj/commits/main" --data-urlencode "author=nobody@example.org"
body_has "empty author history says so" 'No commits here are by'

# ---- finding things: by name and by content ----

check "file finder" 200 "$BASE/demo/proj/find/main"
body_has "finder lists a file" 'class="find-item" href="/demo/proj/blob/main/README.md"'
check "finder without a ref" 200 "$BASE/demo/proj/find"
check "search with no query" 200 "$BASE/demo/proj/search"
body_has "search invites a query" 'Type to search the files at main'
# The web edit above replaced the README's body, so the text searched for here
# is that edit's, not the description the repository was created with.
check "search finds a line" 200 --get "$BASE/demo/proj/search" --data-urlencode "q=Edited via"
body_has "search links the matching line" 'class="search-hit" href="/demo/proj/blob/main/README.md#L'
body_has "search marks the match" '<mark>Edited via</mark>'
check "search that matches nothing" 200 --get "$BASE/demo/proj/search" --data-urlencode "q=zzz-no-such-text"
body_has "empty search says so" 'No file at main contains'
check "search on an unknown ref falls back to the default branch" 200 --get "$BASE/demo/proj/search" \
  --data-urlencode "q=Demo" --data-urlencode ref=no-such-ref
body_has "search box is in the repository header" 'class="repo-search"'

# ---- blame ----

check "blame page" 200 "$BASE/demo/proj/blame/main/README.md"
body_has "blame names a commit" 'class="blame-subject"'
body_has "blame numbers its lines" 'id="L1"'
body_has "blame links back to the file view" ">Code<"
check "blame of a directory 404s" 404 "$BASE/demo/proj/blame/main"
check "blame of a missing file 404s" 404 "$BASE/demo/proj/blame/main/no-such-file"
check "blame button on the blob page" 200 "$BASE/demo/proj/blob/main/README.md"
body_has "blob page offers blame" "/demo/proj/blame/main/README.md"

# ---- history for one path ----

check "history of a file" 200 "$BASE/demo/proj/commits/main/README.md"
body_has "history names the path" 'touching this path'
body_has "history row links the commit" 'class="title" href="/demo/proj/commit/'
check "history of a path that was never in the repository" 200 "$BASE/demo/proj/commits/main/nothing-here.txt"
body_has "empty history says so" "Nothing in this ref's history touches"
check "history of a bad ref 404s" 404 "$BASE/demo/proj/commits/no-such-ref"

# ---- blame ----

check "blame a file" 200 "$BASE/demo/proj/blame/main/README.md"
body_has "blame names the commit" 'class="blame-subject"'
body_has "blame numbers its lines" 'id="L1"'
body_has "blame links back to the code view" "href=\"/demo/proj/blob/main/README.md\""
check "blame of a directory 404s" 404 "$BASE/demo/proj/blame/main"
check "blame of a missing file 404s" 404 "$BASE/demo/proj/blame/main/nope.txt"

# ---- source archives ----

check "source archive as tar.gz" 200 -D "$TMP/headers" "$BASE/demo/proj/archive/main.tar.gz"
grep -qi 'content-type: application/gzip' "$TMP/headers" || { echo "FAIL: archive content-type not gzip"; exit 1; }
grep -qi 'content-disposition: attachment; filename="proj-main.tar.gz"' "$TMP/headers" || { echo "FAIL: archive filename header missing"; exit 1; }
PASS=$((PASS+2)); echo "ok: archive content-type and filename"
tar tzf "$BODY" | grep -q '^proj-main/README.md$' || { echo "FAIL: archive does not unpack under proj-main/"; exit 1; }
PASS=$((PASS+1)); echo "ok: archive unpacks under a named directory"
check "source archive as zip" 200 "$BASE/demo/proj/archive/main.zip"
[ "$(head -c 2 "$BODY")" = "PK" ] || { echo "FAIL: zip archive is not a zip"; exit 1; }
PASS=$((PASS+1)); echo "ok: zip archive is a zip"
check "archive of an unknown ref 404s" 404 "$BASE/demo/proj/archive/nope.zip"
check "archive in an unknown format 404s" 404 "$BASE/demo/proj/archive/main.rar"

# ---- releases, and feeds ----

check "tags page before a release" 200 -b "$JAR" "$BASE/demo/proj/tags"
CSRF="$(csrf_of)"
check "create a tag to release" 302 -b "$JAR" "$BASE/demo/proj/tags/create" \
  --data-urlencode "csrf=$CSRF" --data-urlencode name=v2.0.0 --data-urlencode at=main
check "empty release list" 200 "$BASE/demo/proj/releases"
body_has "empty release list says so" 'No releases yet'
check "anonymous draft redirects to sign in" 302 "$BASE/demo/proj/releases/new"
check "anonymous release POST forbidden" 403 -X POST "$BASE/demo/proj/releases/new"
check "release form" 200 -b "$JAR" --get "$BASE/demo/proj/releases/new" --data-urlencode tag=v2.0.0
CSRF="$(csrf_of)"
check "publish a release" 302 -b "$JAR" "$BASE/demo/proj/releases/new" \
  --data-urlencode "csrf=$CSRF" --data-urlencode tag=v2.0.0 --data-urlencode "name=Version two" \
  --data-urlencode "body=Notes for **two**."
check "release page" 200 "$BASE/demo/proj/releases/tag/v2.0.0"
body_has "release names itself" 'Version two'
body_has "release notes are rendered markdown" '<strong>two</strong>'
body_has "release offers the source" 'archive/v2.0.0.zip'
check "release list carries it" 200 "$BASE/demo/proj/releases"
body_has "newest release is marked latest" 'chip-latest'
check "release notes live in the vault" 200 "$BASE/demo/proj/tags"
body_has "tag row links its release" 'releases/tag/v2.0.0'
check "release for a tag with no notes 404s" 404 "$BASE/demo/proj/releases/tag/v1.0.0"
check "release on a tag that does not exist is refused" 400 -b "$JAR" "$BASE/demo/proj/releases/new" \
  --data-urlencode "csrf=$CSRF" --data-urlencode tag=no-such-tag --data-urlencode "body=x"
check "release feed" 200 -D "$TMP/headers" "$BASE/demo/proj/releases.atom"
grep -qi 'content-type: application/atom' "$TMP/headers" || { echo "FAIL: feed content-type not atom"; exit 1; }
PASS=$((PASS+1)); echo "ok: feed content-type"
body_has "release feed names the release" '<title>Version two</title>'
check "commit feed" 200 "$BASE/demo/proj/commits/main.atom"
body_has "commit feed has entries" '<entry>'
check "commit feed for one path" 200 "$BASE/demo/proj/commits/main/README.md.atom"

# ---- JSON API ----

check "api whoami" 200 -H "Authorization: Bearer $OWNER_TOKEN" "$BASE/api/whoami"
body_has "whoami username" '"username":"owner"'
check "api rejects session cookie" 401 -b "$JAR" "$BASE/api/whoami"

# ---- hubbit login: the token in git's credential store ----

# An isolated HOME so this never touches the developer's own git configuration,
# and an askpass that trips a wire rather than answering, standing in for an
# editor's credential dialog. Nothing in this section may ask for a credential,
# and a tripwire says so immediately where a dialog would simply wait.
CRED_HOME="$TMP/credhome"
TRIPPED="$TMP/askpass-was-called"
mkdir -p "$CRED_HOME"
cat > "$TMP/askpass" <<ASKPASS
#!/bin/sh
touch "$TRIPPED"
exit 1
ASKPASS
chmod +x "$TMP/askpass"
# The global config goes with the isolated HOME, so that what `hubbit login`
# writes lands there and starts out empty: the first check needs no helper to
# be configured anywhere git will look.
cred_env() { env HOME="$CRED_HOME" GIT_CONFIG_GLOBAL="$CRED_HOME/.gitconfig" GIT_ASKPASS="$TMP/askpass" SSH_ASKPASS="$TMP/askpass" "$@"; }
cli() { cred_env node dist/index.js "$@"; }

run_ok() {
  local desc="$1"; shift
  if ! "$@" > "$BODY" 2>&1; then echo "FAIL: $desc"; head -c 2000 "$BODY"; echo; exit 1; fi
  PASS=$((PASS+1)); echo "ok: $desc"
}
run_fails() {
  local desc="$1"; shift
  if "$@" > "$BODY" 2>&1; then echo "FAIL: $desc (expected a non-zero exit)"; head -c 2000 "$BODY"; echo; exit 1; fi
  PASS=$((PASS+1)); echo "ok: $desc"
}
no_prompt() {
  local desc="$1"
  if [ -e "$TRIPPED" ]; then echo "FAIL: $desc (git asked for a credential)"; exit 1; fi
  PASS=$((PASS+1)); echo "ok: $desc"
}

# `git credential approve` with no helper configured stores nothing and still
# exits zero, so login has to refuse rather than report success.
run_fails "login refuses when no credential helper is configured" \
  cli login --host "$BASE" --token "$OWNER_TOKEN"
body_has "login names the helpers it could use" 'hubbit login --helper store'

run_fails "login refuses a bad token before storing it" \
  cli login --host "$BASE" --token hubbit_not_a_real_token --helper store
if [ -e "$CRED_HOME/.git-credentials" ]; then echo "FAIL: a rejected token was stored anyway"; exit 1; fi
PASS=$((PASS+1)); echo "ok: nothing stored for a rejected token"

run_ok "login stores the token" cli login --host "$BASE" --token "$OWNER_TOKEN" --helper store
grep -q "$OWNER_TOKEN" "$CRED_HOME/.git-credentials" || { echo "FAIL: token not in the credential store"; exit 1; }
PASS=$((PASS+1)); echo "ok: token is in the credential store"
CRED_MODE="$(stat -c '%a' "$CRED_HOME/.git-credentials" 2>/dev/null || stat -f '%Lp' "$CRED_HOME/.git-credentials")"
[ "$CRED_MODE" = 600 ] || { echo "FAIL: credential file is mode $CRED_MODE, not 0600"; exit 1; }
PASS=$((PASS+1)); echo "ok: credential file is mode 0600"
# Recorded for this host alone, so other remotes keep whatever they use now.
cred_env git config --global --get-regexp '^credential\.' | grep -q "credential.$BASE.helper store" \
  || { echo "FAIL: helper not recorded for this host alone"; exit 1; }
PASS=$((PASS+1)); echo "ok: helper recorded for this host alone"

# The point of all of it: clone and push that ask nothing, with no token in the
# environment. git-lfs is covered further down, through the same store.
rm -rf "$TMP/credclone"
run_ok "clone with only a stored credential" cred_env git clone -q "$BASE/demo/proj" "$TMP/credclone"
git -C "$TMP/credclone" commit -q --allow-empty -m "pushed with a stored credential"
run_ok "push with only a stored credential" cred_env git -C "$TMP/credclone" push -q origin HEAD:main
no_prompt "neither clone nor push asked for a credential"

run_ok "logout removes it" cli logout --host "$BASE"
if [ -s "$CRED_HOME/.git-credentials" ]; then echo "FAIL: credential still stored after logout"; exit 1; fi
PASS=$((PASS+1)); echo "ok: credential file is empty after logout"
run_ok "logout again is not an error" cli logout --host "$BASE"
body_has "logout says there was nothing stored" 'No stored credential'
no_prompt "reading the store back never prompts"

# ---- git over HTTP ----

check "push needs auth" 401 "$BASE/newcollection/newrepo/info/refs?service=git-receive-pack"

git clone -q "$BASE/demo/proj" "$TMP/clone" 2>/dev/null
grep -q 'Edited via the web interface' "$TMP/clone/README.md" || { echo "FAIL: clone missing web edit"; exit 1; }
PASS=$((PASS+1)); echo "ok: anonymous clone sees web commits"

cd "$TMP/clone"
git config user.name "Smoke Test"
git config user.email smoke@example.org
echo "pushed line" >> README.md
git commit -qam "Push from smoke test"
git push -q "http://owner:$OWNER_TOKEN@127.0.0.1:$PORT/demo/proj" main 2>/dev/null
git push -q "http://owner:$OWNER_TOKEN@127.0.0.1:$PORT/pushed/created" main 2>/dev/null
cd - >/dev/null
PASS=$((PASS+1)); echo "ok: authenticated push and push-to-create"

check "pushed commit visible" 200 "$BASE/demo/proj/blob/main/README.md"
body_has "pushed content" 'pushed line'
check "push-created repo visible" 200 "$BASE/pushed/created"

# ---- site ----

mkdir -p "$VAULT/pushed/created.site"
echo '<h1>site ok</h1>' > "$VAULT/pushed/created.site/index.html"
check "site served" 200 "$BASE/pushed/created/site/"
body_has "site content" 'site ok'

# ---- Git LFS: batch API and local transfer routes ----
# All of this runs against the local backend, so the suite needs no bucket
# credentials.

check "new repo form for lfs" 200 -b "$JAR" "$BASE/new"
CSRF="$(csrf_of)"
check "create demo/lfsdemo" 302 -b "$JAR" "$BASE/new" \
  --data-urlencode "csrf=$CSRF" --data-urlencode collection=demo --data-urlencode name=lfsdemo \
  --data-urlencode init=1

LFS_BATCH="$BASE/demo/lfsdemo/info/lfs/objects/batch"
LFS_VERIFY="$BASE/demo/lfsdemo/info/lfs/objects/verify"
LFS_CT='Content-Type: application/vnd.git-lfs+json'
printf 'hello lfs content' > "$TMP/lfs-obj"
LFS_OID="$(sha256sum "$TMP/lfs-obj" | cut -d' ' -f1)"
LFS_SIZE="$(wc -c < "$TMP/lfs-obj" | tr -d ' ')"

check "batch download of an absent object" 200 -X POST "$LFS_BATCH" -H "$LFS_CT" \
  -d '{"operation":"download","transfers":["basic"],"objects":[{"oid":"'"$LFS_OID"'","size":'"$LFS_SIZE"'}]}'
body_has "absent object carries a per-object 404" '"code":404'
body_lacks "absent object gets no download action" '"actions"'

# git-lfs derives its endpoint by appending .git/info/lfs to the remote URL,
# so the .git-suffixed path must resolve to the same repository.
check "batch endpoint resolves under the .git suffix" 200 -X POST \
  "$BASE/demo/lfsdemo.git/info/lfs/objects/batch" -H "$LFS_CT" \
  -d '{"operation":"download","objects":[]}'
body_has "empty batch is valid" '"objects":\[\]'

check "anonymous batch upload is 401" 401 -D "$TMP/lfs-headers" -X POST "$LFS_BATCH" -H "$LFS_CT" \
  -d '{"operation":"upload","objects":[{"oid":"'"$LFS_OID"'","size":'"$LFS_SIZE"'}]}'
grep -qi 'lfs-authenticate: basic' "$TMP/lfs-headers" || { echo "FAIL: 401 without LFS-Authenticate"; exit 1; }
PASS=$((PASS+1)); echo "ok: 401 carries LFS-Authenticate"

check "batch upload without push scope is 403" 403 -u "alice:$ALICE_TOKEN" -X POST \
  "$BASE/pushed/created/info/lfs/objects/batch" -H "$LFS_CT" \
  -d '{"operation":"upload","objects":[{"oid":"'"$LFS_OID"'","size":'"$LFS_SIZE"'}]}'

check "malformed object id is 422" 422 -u "owner:$OWNER_TOKEN" -X POST "$LFS_BATCH" -H "$LFS_CT" \
  -d '{"operation":"upload","objects":[{"oid":"not-an-oid","size":3}]}'

check "unsupported transfer adapter is 422" 422 -X POST "$LFS_BATCH" -H "$LFS_CT" \
  -d '{"operation":"download","transfers":["custom"],"objects":[]}'

LFS_BIG_OID="$(printf 'oversize' | sha256sum | cut -d' ' -f1)"
check "oversize upload gets a per-object 422" 200 -u "owner:$OWNER_TOKEN" -X POST "$LFS_BATCH" -H "$LFS_CT" \
  -d '{"operation":"upload","objects":[{"oid":"'"$LFS_BIG_OID"'","size":6000000000}]}'
body_has "per-object size error" '"code":422'
body_has "size error names the limit" '5000000000'

check "batch upload offers actions" 200 -u "owner:$OWNER_TOKEN" -X POST "$LFS_BATCH" -H "$LFS_CT" \
  -d '{"operation":"upload","objects":[{"oid":"'"$LFS_OID"'","size":'"$LFS_SIZE"'}]}'
body_has "upload action offered" '"upload":{"href"'
body_has "verify action offered" '"verify":{"href"'
LFS_UPLOAD_URL="$({ grep -o '"href":"[^"]*"' "$BODY" || true; } | head -1 | sed 's/^"href":"//;s/"$//')"
[ -n "$LFS_UPLOAD_URL" ] || { echo "FAIL: no upload href in the batch response"; exit 1; }

check "tampered transfer signature is 403" 403 -X PUT --data-binary "@$TMP/lfs-obj" "${LFS_UPLOAD_URL}Zm9v"
LFS_EXPIRED_URL="$(printf '%s' "$LFS_UPLOAD_URL" | sed 's/exp=[0-9]*/exp=1000000000/')"
check "expired transfer URL is 403" 403 -X PUT --data-binary "@$TMP/lfs-obj" "$LFS_EXPIRED_URL"
# Every byte in the URL must be covered by the signature, so an exp that only
# survives a lenient parse has to be refused rather than truncated.
check "trailing junk on exp is 403" 403 -X PUT --data-binary "@$TMP/lfs-obj" \
  "$(printf '%s' "$LFS_UPLOAD_URL" | sed 's/\(exp=[0-9]*\)/\1zzz/')"

LFS_STORED="$VAULT/demo/lfsdemo.lfs/${LFS_OID:0:2}/${LFS_OID:2:2}/$LFS_OID"
check "upload with mismatched content is 422" 422 -X PUT --data-binary 'not the content' "$LFS_UPLOAD_URL"
[ ! -e "$LFS_STORED" ] || { echo "FAIL: mismatched upload left an object behind"; exit 1; }
PASS=$((PASS+1)); echo "ok: mismatched upload leaves no object"

check "upload the object" 200 -X PUT --data-binary "@$TMP/lfs-obj" "$LFS_UPLOAD_URL"
[ -e "$LFS_STORED" ] || { echo "FAIL: uploaded object not stored in the vault"; exit 1; }
PASS=$((PASS+1)); echo "ok: object stored under <repo>.lfs"

check "verify a correct upload" 200 -u "owner:$OWNER_TOKEN" -X POST "$LFS_VERIFY" -H "$LFS_CT" \
  -d '{"oid":"'"$LFS_OID"'","size":'"$LFS_SIZE"'}'
check "verify with a size mismatch is 422" 422 -u "owner:$OWNER_TOKEN" -X POST "$LFS_VERIFY" -H "$LFS_CT" \
  -d '{"oid":"'"$LFS_OID"'","size":9999}'
LFS_ABSENT_OID="$(printf 'never uploaded' | sha256sum | cut -d' ' -f1)"
check "verify of an absent object is 404" 404 -u "owner:$OWNER_TOKEN" -X POST "$LFS_VERIFY" -H "$LFS_CT" \
  -d '{"oid":"'"$LFS_ABSENT_OID"'","size":14}'

check "second identical upload batch deduplicates" 200 -u "owner:$OWNER_TOKEN" -X POST "$LFS_BATCH" -H "$LFS_CT" \
  -d '{"operation":"upload","objects":[{"oid":"'"$LFS_OID"'","size":'"$LFS_SIZE"'}]}'
body_lacks "no actions on an already-stored object" '"actions"'

check "batch download of the stored object" 200 -X POST "$LFS_BATCH" -H "$LFS_CT" \
  -d '{"operation":"download","objects":[{"oid":"'"$LFS_OID"'","size":'"$LFS_SIZE"'}]}'
body_has "download action offered" '"download":{"href"'
# Repeated object ids share one storage lookup but must still be answered one
# for one, so an anonymous request cannot fan out to the bucket.
check "a repeated object id is answered once per request entry" 200 -X POST "$LFS_BATCH" -H "$LFS_CT" \
  -d '{"operation":"download","objects":[{"oid":"'"$LFS_OID"'","size":'"$LFS_SIZE"'},{"oid":"'"$LFS_OID"'","size":'"$LFS_SIZE"'},{"oid":"'"$LFS_OID"'","size":'"$LFS_SIZE"'}]}'
[ "$(grep -o '"oid"' "$BODY" | wc -l)" = 3 ] || { echo "FAIL: repeated oids not answered one for one"; head -c 500 "$BODY"; exit 1; }
PASS=$((PASS+1)); echo "ok: three repeated oids yield three response objects"
LFS_DL_URL="$({ grep -o '"href":"[^"]*"' "$BODY" || true; } | head -1 | sed 's/^"href":"//;s/"$//')"
curl -sS -o "$TMP/lfs-roundtrip" "$LFS_DL_URL"
cmp -s "$TMP/lfs-obj" "$TMP/lfs-roundtrip" || { echo "FAIL: downloaded object differs from the upload"; exit 1; }
PASS=$((PASS+1)); echo "ok: object bytes round-trip through the transfer routes"

# Push-to-create has to survive LFS. git fetches the remote's refs before
# running the pre-push hook that uploads objects, and that advertisement is
# what creates the repository, so the batch call that follows must find it.
check "batch upload 404s before the repository exists" 404 -u "owner:$OWNER_TOKEN" -X POST \
  "$BASE/fresh/lfsrepo.git/info/lfs/objects/batch" -H "$LFS_CT" \
  -d '{"operation":"upload","objects":[{"oid":"'"$LFS_OID"'","size":'"$LFS_SIZE"'}]}'
check "the receive-pack advertisement creates it" 200 -u "owner:$OWNER_TOKEN" \
  "$BASE/fresh/lfsrepo.git/info/refs?service=git-receive-pack"
[ -d "$VAULT/fresh/lfsrepo.git" ] || { echo "FAIL: advertisement did not create the repository"; exit 1; }
PASS=$((PASS+1)); echo "ok: advertisement created the repository"
check "batch upload then succeeds, as it does mid-push" 200 -u "owner:$OWNER_TOKEN" -X POST \
  "$BASE/fresh/lfsrepo.git/info/lfs/objects/batch" -H "$LFS_CT" \
  -d '{"operation":"upload","objects":[{"oid":"'"$LFS_OID"'","size":'"$LFS_SIZE"'}]}'
body_has "upload offered on the freshly created repo" '"upload":{"href"'

# ---- Git LFS: web interface ----
# A pointer file committed through the web form stands in for a git-lfs push,
# so these checks need no LFS client.

check "new pointer file form" 200 -b "$JAR" "$BASE/demo/lfsdemo/new/main"
CSRF="$(csrf_of)"; EXPECTED="$(expected_of)"
check "commit a pointer file" 302 -b "$JAR" "$BASE/demo/lfsdemo/new/main" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "expected=$EXPECTED" \
  --data-urlencode filename=data.bin \
  --data-urlencode "content=version https://git-lfs.github.com/spec/v1
oid sha256:$LFS_OID
size $LFS_SIZE
" --data-urlencode "message=Add LFS pointer"

check "blob page shows the download card" 200 "$BASE/demo/lfsdemo/blob/main/data.bin"
body_has "card names Git LFS" 'Stored with Git LFS'
body_has "card shows the true size" "$LFS_SIZE B"
body_has "card shows the object id" "sha256:$LFS_OID"
body_lacks "pointer text not rendered as content" 'class="lnum"'
check "plain view shows the pointer source" 200 "$BASE/demo/lfsdemo/blob/main/data.bin?plain=1"
body_has "pointer source visible" 'version https://git-lfs.github.com/spec/v1'

check "malformed JSON body is 422 in the LFS error shape" 422 -X POST "$LFS_BATCH" -H "$LFS_CT" -d 'not json'
body_has "parse failure uses the LFS message shape" '"message"'

# An LFS-tracked file whose name suggests an image must still show the card,
# and ?plain=1 must reach the pointer source rather than rendering an image.
check "new pointer image form" 200 -b "$JAR" "$BASE/demo/lfsdemo/new/main"
CSRF="$(csrf_of)"; EXPECTED="$(expected_of)"
check "commit an LFS-tracked .png pointer" 302 -b "$JAR" "$BASE/demo/lfsdemo/new/main" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "expected=$EXPECTED" \
  --data-urlencode filename=picture.png \
  --data-urlencode "content=version https://git-lfs.github.com/spec/v1
oid sha256:$LFS_OID
size $LFS_SIZE
" --data-urlencode "message=Add LFS-tracked image"
check "tracked image shows the card, not an img tag" 200 "$BASE/demo/lfsdemo/blob/main/picture.png"
body_has "image card names Git LFS" 'Stored with Git LFS'
body_lacks "pointer not rendered as an image" '<div class="blob-image">'
check "tracked image plain view" 200 "$BASE/demo/lfsdemo/blob/main/picture.png?plain=1"
body_has "plain view of a tracked image shows the pointer" 'oid sha256:'
body_lacks "plain view of a tracked image is not an image" '<div class="blob-image">'

check "raw route redirects to the object" 302 "$BASE/demo/lfsdemo/raw/main/data.bin"
curl -sSL -o "$TMP/lfs-raw" -D "$TMP/lfs-dl-headers" "$BASE/demo/lfsdemo/raw/main/data.bin"
cmp -s "$TMP/lfs-obj" "$TMP/lfs-raw" || { echo "FAIL: raw download differs from the stored object"; exit 1; }
PASS=$((PASS+1)); echo "ok: raw route serves the stored bytes"
# LFS objects are repository content on this origin, so they carry the same
# sandbox CSP and attachment disposition the raw route uses for everything
# else; an uploaded HTML or SVG payload must never run as script here.
grep -qi 'content-security-policy: sandbox' "$TMP/lfs-dl-headers" || { echo "FAIL: LFS download lacks the sandbox CSP"; exit 1; }
grep -qi 'content-disposition: attachment' "$TMP/lfs-dl-headers" || { echo "FAIL: LFS download is not an attachment"; exit 1; }
PASS=$((PASS+2)); echo "ok: LFS download carries the sandbox CSP and attachment disposition"
curl -sS -o /dev/null -D "$TMP/lfs-batch-headers" "$LFS_DL_URL"
grep -qi 'content-security-policy: sandbox' "$TMP/lfs-batch-headers" || { echo "FAIL: batch-issued download lacks the sandbox CSP"; exit 1; }
grep -qi 'content-disposition: attachment' "$TMP/lfs-batch-headers" || { echo "FAIL: batch-issued download is not an attachment"; exit 1; }
PASS=$((PASS+2)); echo "ok: batch-issued download is sandboxed too"

check "editing a pointer file is refused" 400 -b "$JAR" "$BASE/demo/lfsdemo/edit/main/data.bin"
body_has "refusal names Git LFS" 'stored with Git LFS'
CSRF="$(csrf_of)"
check "posting an edit to a pointer file is refused too" 400 -b "$JAR" "$BASE/demo/lfsdemo/edit/main/data.bin" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "expected=$(git -C "$VAULT/demo/lfsdemo.git" rev-parse main)" \
  --data-urlencode "content=clobbered" --data-urlencode "message=clobber"
check "delete form for a pointer file is offered" 200 -b "$JAR" "$BASE/demo/lfsdemo/delete/main/data.bin"

# The real pointer format allows extension lines, which the strict parser
# rejects on purpose. The edit refusal must still cover them, or the browser
# editor could commit text over such a file.
check "new extension-pointer form" 200 -b "$JAR" "$BASE/demo/lfsdemo/new/main"
CSRF="$(csrf_of)"; EXPECTED="$(expected_of)"
check "commit a pointer carrying an extension line" 302 -b "$JAR" "$BASE/demo/lfsdemo/new/main" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "expected=$EXPECTED" \
  --data-urlencode filename=ext.bin \
  --data-urlencode "content=version https://git-lfs.github.com/spec/v1
ext-0-foo sha256:$LFS_OID
oid sha256:$LFS_OID
size $LFS_SIZE
" --data-urlencode "message=Pointer with an extension"
check "editing an extension pointer is refused" 400 -b "$JAR" "$BASE/demo/lfsdemo/edit/main/ext.bin"
body_has "extension refusal names Git LFS" 'stored with Git LFS'

# A pointer whose object was never uploaded 404s on the raw route.
check "new missing-pointer form" 200 -b "$JAR" "$BASE/demo/lfsdemo/new/main"
CSRF="$(csrf_of)"; EXPECTED="$(expected_of)"
check "commit a pointer to a missing object" 302 -b "$JAR" "$BASE/demo/lfsdemo/new/main" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "expected=$EXPECTED" \
  --data-urlencode filename=gone.bin \
  --data-urlencode "content=version https://git-lfs.github.com/spec/v1
oid sha256:$LFS_ABSENT_OID
size 14
" --data-urlencode "message=Pointer without an object"
check "raw route 404s when the object is missing" 404 "$BASE/demo/lfsdemo/raw/main/gone.bin"
body_has "missing-object message" 'missing from storage'

# ---- Git LFS: real client round trip (skipped without git-lfs) ----

if git lfs version >/dev/null 2>&1; then
  LFS_CLONE="$TMP/lfs-clone"
  git clone -q "http://owner:$OWNER_TOKEN@127.0.0.1:$PORT/demo/lfsdemo" "$LFS_CLONE" 2>/dev/null
  (
    cd "$LFS_CLONE"
    git config user.name "Smoke Test"
    git config user.email smoke@example.org
    # --local, so the checks work whether or not `git lfs install` has been
    # run for the user running the suite.
    git lfs install --local >/dev/null
    git lfs track '*.dat' >/dev/null
    head -c 300 /dev/urandom > big.dat
    git add .gitattributes big.dat
    git commit -qm "Add an LFS-tracked file"
    git push -q origin main 2>/dev/null
  )
  PASS=$((PASS+1)); echo "ok: git lfs push"
  git -C "$VAULT/demo/lfsdemo.git" cat-file blob main:big.dat | head -1 \
    | grep -q '^version https://git-lfs' || { echo "FAIL: pushed blob is not an LFS pointer"; exit 1; }
  PASS=$((PASS+1)); echo "ok: repository blob is a pointer"
  # No credentials on this clone: it is the check that catches an
  # over-tightened batch endpoint. Whether the objects arrive through the
  # clone's smudge filter or through the explicit pull, both go through the
  # anonymous download path.
  git clone -q "$BASE/demo/lfsdemo" "$TMP/lfs-anon" 2>/dev/null
  (cd "$TMP/lfs-anon" && git lfs install --local >/dev/null && git lfs pull)
  cmp -s "$LFS_CLONE/big.dat" "$TMP/lfs-anon/big.dat" || { echo "FAIL: anonymous git lfs pull did not round-trip"; exit 1; }
  PASS=$((PASS+1)); echo "ok: anonymous clone and git lfs pull round-trip"
  check "client-pushed file shows the card" 200 "$BASE/demo/lfsdemo/blob/main/big.dat"
  body_has "client-pushed file true size" '300 B'
  curl -sSL -o "$TMP/lfs-client-raw" "$BASE/demo/lfsdemo/raw/main/big.dat"
  cmp -s "$LFS_CLONE/big.dat" "$TMP/lfs-client-raw" || { echo "FAIL: raw of client-pushed file differs"; exit 1; }
  PASS=$((PASS+1)); echo "ok: raw route serves the client-pushed bytes"
  check "editing the client-pushed file is refused" 400 -b "$JAR" "$BASE/demo/lfsdemo/edit/main/big.dat"
else
  echo "skip: git lfs is not installed; skipping the LFS client checks"
fi

# ---- Git LFS: repository deletion removes stored objects ----

check "settings for lfs repo deletion" 200 -b "$JAR" "$BASE/demo/lfsdemo/settings"
CSRF="$(csrf_of)"
check "delete the lfs repo" 302 -b "$JAR" "$BASE/demo/lfsdemo/settings/delete" \
  --data-urlencode "csrf=$CSRF" --data-urlencode confirm=demo/lfsdemo
[ ! -e "$VAULT/demo/lfsdemo.lfs" ] || { echo "FAIL: .lfs directory survived repository deletion"; exit 1; }
PASS=$((PASS+1)); echo "ok: repository deletion removed its LFS objects"

# ---- Actions: planning, the runner protocol, and the UI ----
#
# Planning, dispatch, cancellation, and the runner API are checked without
# Docker; actually executing a job needs it, so those checks skip when it is
# absent, as the git-lfs client checks do above.

CI_REPO="$TMP/cirepo"
git init -q -b main "$CI_REPO"
mkdir -p "$CI_REPO/.github/workflows" "$CI_REPO/.hubbit/workflows"

cat > "$CI_REPO/.github/workflows/build.yml" <<'YML'
name: Build
on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      greeting:
        description: What to say
        default: hello
env:
  GREETING: from-workflow
jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      version: ${{ steps.meta.outputs.version }}
    steps:
      - name: Say hello
        run: echo "greeting=$GREETING repo=$GITHUB_REPOSITORY"
      - name: Set an output
        id: meta
        run: echo "version=1.2.3" >> "$GITHUB_OUTPUT"
      - name: Use the output
        run: echo "version is ${{ steps.meta.outputs.version }}"
  fan:
    needs: build
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        n: [1, 2]
    steps:
      - run: echo "n=${{ matrix.n }} version=${{ needs.build.outputs.version }}"
      - name: Fail on two
        if: matrix.n == 2
        run: exit 3
YML

# Shadowed by name: this .github copy must never run, because a file with the
# same basename exists under .hubbit/workflows.
cat > "$CI_REPO/.github/workflows/shadowed.yml" <<'YML'
name: Shadowed by hubbit
on: [push]
jobs:
  ghost:
    runs-on: ubuntu-latest
    steps:
      - run: echo "this must not run"
YML
cat > "$CI_REPO/.hubbit/workflows/shadowed.yml" <<'YML'
name: Hubbit override
on: [push]
jobs:
  real:
    runs-on: ubuntu-latest
    steps:
      - run: echo "the hubbit copy runs"
YML

cat > "$CI_REPO/.github/workflows/tagsonly.yml" <<'YML'
name: Tags only
on:
  push:
    tags: ['v*']
jobs:
  never:
    runs-on: ubuntu-latest
    steps:
      - run: echo "not on a branch push"
YML

cat > "$CI_REPO/.github/workflows/broken.yml" <<'YML'
name: Broken
on: [push]
jobs:
  oops:
    runs-on: ubuntu-latest
YML

echo "# ci" > "$CI_REPO/README.md"
git -C "$CI_REPO" add -A
git -C "$CI_REPO" -c user.email=ci@example.com -c user.name=ci commit -qm "Add workflows"
git -C "$CI_REPO" push -q "http://owner:$OWNER_TOKEN@127.0.0.1:$PORT/demo/ci" main
sleep 1

RUNS="$VAULT/demo/ci.runs"
[ -d "$RUNS" ] || { echo "FAIL: no .runs directory after a push"; exit 1; }
PASS=$((PASS+1)); echo "ok: push created run state in the vault"

run_field() { python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],''))" "$1" "$2"; }
job_field() { python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],''))" "$1" "$2"; }
runs_named() {
  python3 - "$RUNS" "$1" <<'PY'
import json, os, sys
base, name = sys.argv[1], sys.argv[2]
out = []
for e in sorted(os.listdir(base)):
    f = os.path.join(base, e, 'run.json')
    if os.path.exists(f):
        r = json.load(open(f))
        if r['workflowName'] == name: out.append(e)
print(' '.join(out))
PY
}

[ -n "$(runs_named 'Build')" ] || { echo "FAIL: the push did not plan the Build workflow"; exit 1; }
PASS=$((PASS+1)); echo "ok: a matching push trigger plans a run"
[ -n "$(runs_named 'Hubbit override')" ] || { echo "FAIL: .hubbit/workflows copy did not run"; exit 1; }
PASS=$((PASS+1)); echo "ok: .hubbit/workflows shadows .github/workflows by basename"
[ -z "$(runs_named 'Shadowed by hubbit')" ] || { echo "FAIL: the shadowed .github copy ran"; exit 1; }
PASS=$((PASS+1)); echo "ok: the shadowed .github copy does not run"
[ -z "$(runs_named 'Tags only')" ] || { echo "FAIL: a tags-only workflow ran on a branch push"; exit 1; }
PASS=$((PASS+1)); echo "ok: branch push does not fire a tags-only trigger"
[ -n "$(runs_named 'broken.yml')" ] || { echo "FAIL: the broken workflow produced no visible run"; exit 1; }
PASS=$((PASS+1)); echo "ok: an unparseable workflow file produces a failed run rather than silence"

BUILD_RUN="$(runs_named 'Build' | awk '{print $1}')"
[ -f "$RUNS/$BUILD_RUN/jobs/build.json" ] || { echo "FAIL: no build job planned"; exit 1; }
[ -f "$RUNS/$BUILD_RUN/jobs/fan-1.json" ] && [ -f "$RUNS/$BUILD_RUN/jobs/fan-2.json" ] || {
  echo "FAIL: the matrix did not expand into two jobs"; exit 1; }
PASS=$((PASS+1)); echo "ok: the matrix expands into one job per combination"

cat > "$CI_REPO/.github/workflows/badjobid.yml" <<'YML'
name: Bad job id
on: [push]
jobs:
  "../../escape":
    runs-on: ubuntu-latest
    steps:
      - run: echo "a job id must never become a path"
YML
git -C "$CI_REPO" add -A
git -C "$CI_REPO" -c user.email=ci@example.com -c user.name=ci commit -qm "A workflow with a job id shaped like a path"
git -C "$CI_REPO" push -q "http://owner:$OWNER_TOKEN@127.0.0.1:$PORT/demo/ci" main
sleep 1
[ -z "$(runs_named 'Bad job id')" ] || { echo "FAIL: a path-shaped job id was accepted"; exit 1; }
PASS=$((PASS+1)); echo "ok: a job id shaped like a path is refused rather than written"
[ ! -e "$VAULT/demo/escape.json" ] && [ ! -e "$VAULT/escape.json" ] || {
  echo "FAIL: a job record escaped the runs directory"; exit 1; }
PASS=$((PASS+1)); echo "ok: nothing was written outside the runs directory"
[ -n "$(runs_named 'badjobid.yml')" ] || { echo "FAIL: the rejected workflow produced no visible run"; exit 1; }
PASS=$((PASS+1)); echo "ok: the rejection is visible as a failed run, not silence"

# ---- the Actions UI ----

check "actions tab on the repo page" 200 "$BASE/demo/ci"
body_has "Actions tab present" 'href="/demo/ci/actions"'
check "runs list renders" 200 "$BASE/demo/ci/actions"
body_has "the run is listed" 'Add workflows'
body_has "workflow filter present" 'Build'
check "run page renders" 200 "$BASE/demo/ci/actions/runs/$BUILD_RUN"
body_has "jobs listed on the run page" 'job-item'
check "log tail endpoint" 200 "$BASE/demo/ci/actions/runs/$BUILD_RUN/log/build?offset=0"
body_has "log tail is json" '"offset"'
check "unknown run is 404" 404 "$BASE/demo/ci/actions/runs/9999"
check "anonymous cancel is refused" 403 -X POST "$BASE/demo/ci/actions/runs/$BUILD_RUN/cancel"

# ---- workflow_dispatch from the UI ----

check "actions page for csrf" 200 -b "$JAR" "$BASE/demo/ci/actions"
CSRF="$(csrf_of)"
[ -n "$CSRF" ] || { echo "FAIL: no dispatch form for a user with push scope"; exit 1; }
check "dispatch a workflow" 302 -b "$JAR" "$BASE/demo/ci/actions/dispatch" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "workflow=.github/workflows/build.yml" \
  --data-urlencode ref=main --data-urlencode "input.greeting=hi"
check "dispatching a workflow without the trigger is refused" 400 -b "$JAR" "$BASE/demo/ci/actions/dispatch" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "workflow=.github/workflows/tagsonly.yml" \
  --data-urlencode ref=main

# ---- runner registration and the runner API ----

check "runners admin page" 200 -b "$JAR" "$BASE/admin/runners"
body_has "runner registration form" 'Register a runner'
CSRF="$(csrf_of)"
check "a runner needs an allow list" 400 -b "$JAR" "$BASE/admin/runners" \
  --data-urlencode "csrf=$CSRF" --data-urlencode name=norunner --data-urlencode labels=ubuntu-latest \
  --data-urlencode allow=
check "register a runner" 200 -b "$JAR" "$BASE/admin/runners" \
  --data-urlencode "csrf=$CSRF" --data-urlencode name=smoke --data-urlencode labels=ubuntu-latest \
  --data-urlencode "allow=demo/*"
RUNNER_TOKEN="$({ grep -o 'hubbit_runner_[0-9a-f]\{64\}' "$BODY" || true; } | head -1)"
[ -n "$RUNNER_TOKEN" ] || { echo "FAIL: no runner token shown after registration"; exit 1; }
PASS=$((PASS+1)); echo "ok: registering a runner shows its token once"
[ -f "$VAULT/runners.json" ] || { echo "FAIL: runners.json not written"; exit 1; }
grep -q "$RUNNER_TOKEN" "$VAULT/runners.json" && { echo "FAIL: the runner token was stored in the clear"; exit 1; }
PASS=$((PASS+1)); echo "ok: only the runner token's hash is stored"

check "runner whoami" 200 -H "Authorization: Bearer $RUNNER_TOKEN" "$BASE/api/runner/whoami"
body_has "runner identity" '"smoke"'
check "a user token is not a runner token" 401 -H "Authorization: Bearer $OWNER_TOKEN" "$BASE/api/runner/whoami"
check "a runner token is not a user token" 401 -H "Authorization: Bearer $RUNNER_TOKEN" "$BASE/api/whoami"
check "a runner token cannot register runners" 401 -X POST -H "Authorization: Bearer $RUNNER_TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"x","allow":["*"]}' "$BASE/api/runners"
check "runner list over the API" 200 -H "Authorization: Bearer $OWNER_TOKEN" "$BASE/api/runners"
body_has "the registered runner is listed" '"smoke"'

# A job acquired with a bogus lease may not be reported on.
check "acquire with an unmatched label yields nothing" 204 -X POST \
  -H "Authorization: Bearer $RUNNER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"labels":["windows-latest"]}' "$BASE/api/runner/acquire"
check "status with a bogus lease is refused" 409 -X POST \
  -H "Authorization: Bearer $RUNNER_TOKEN" -H 'Content-Type: application/json' \
  -H 'X-Hubbit-Lease: nonsense' -d '{"lease":"nonsense","status":"completed","conclusion":"success"}' \
  "$BASE/api/runner/jobs/demo/ci/$BUILD_RUN/build/status"

# ---- cancelling a run ----

check "run page for csrf" 200 -b "$JAR" "$BASE/demo/ci/actions/runs/$BUILD_RUN"
CSRF="$(csrf_of)"
check "cancel the run" 302 -b "$JAR" "$BASE/demo/ci/actions/runs/$BUILD_RUN/cancel" \
  --data-urlencode "csrf=$CSRF"
sleep 0.5
[ "$(run_field "$RUNS/$BUILD_RUN/run.json" conclusion)" = "cancelled" ] || {
  echo "FAIL: cancelling did not conclude the run as cancelled"
  run_field "$RUNS/$BUILD_RUN/run.json" status; exit 1; }
PASS=$((PASS+1)); echo "ok: cancelling a queued run concludes it as cancelled"

# ---- the action cache, keyed by the commit a ref names ----
#
# A bare repository served as static files is forge enough for this: git
# falls back to the dumb protocol for ls-remote, and the tarballs the store
# downloads are ordinary files. So these checks need neither the network nor
# Docker. A second tree under byname/ holds the tarballs without the git
# files, which is how the fallback for a forge that cannot be resolved is
# exercised.

FORGE="$TMP/forge"
FORGE_PORT=$((PORT + 1))
FORGE_URL="http://127.0.0.1:$FORGE_PORT"
ACTION_SRC="$TMP/action-src"
ACTION_CACHE="$TMP/action-cache"
mkdir -p "$FORGE/acme"
git init -q "$ACTION_SRC"
cat > "$ACTION_SRC/action.yml" <<'YML'
name: widget-one
description: An action at its first commit
runs:
  using: composite
  steps: []
YML
git -C "$ACTION_SRC" add -A
git -C "$ACTION_SRC" -c user.email=ci@example.com -c user.name=ci commit -qm one
git -C "$ACTION_SRC" -c user.email=ci@example.com -c user.name=ci tag -a v1 -m "release one"
git clone -q --bare "$ACTION_SRC" "$FORGE/acme/widget"

forge_publish() {
  local repo="$FORGE/acme/widget" ref sha
  mkdir -p "$repo/archive" "$FORGE/byname/acme/widget/archive"
  git -C "$repo" update-server-info
  for ref in $(git -C "$repo" for-each-ref --format='%(refname:short)'); do
    sha="$(git -C "$repo" rev-parse "$ref^{commit}")"
    git -C "$repo" archive --format=tar.gz --prefix="widget-$sha/" "$sha" -o "$repo/archive/$sha.tar.gz"
    git -C "$repo" archive --format=tar.gz --prefix="widget-$sha/" "$sha" \
      -o "$FORGE/byname/acme/widget/archive/$ref.tar.gz"
  done
}
forge_publish

python3 -m http.server "$FORGE_PORT" --directory "$FORGE" > "$TMP/forge.log" 2>&1 &
FORGE_PID=$!
for _ in $(seq 1 50); do
  if curl -s -o /dev/null "$FORGE_URL/"; then break; fi
  sleep 0.2
done

cat > "$TMP/action-cache.mjs" <<'JS'
// Drive the runner's ActionStore directly: it needs no server, and the
// question here is which bytes a `uses:` ref resolves to.
const [dist, forgeUrl, cacheDir, uses] = process.argv.slice(2);
const { ActionStore } = await import(`${dist}/runner/actions.js`);
const { parseActionRef } = await import(`${dist}/ci/actionref.js`);
const store = new ActionStore(cacheDir, forgeUrl, process.env.NO_ACTION_CACHE !== '1');
try {
  const r = await store.resolve(parseActionRef(uses), process.cwd(), (l) => console.log(`log=${l}`));
  console.log(`key=${r.key}`);
  console.log(`name=${r.def.name}`);
} catch (e) {
  console.log(`error=${e instanceof Error ? e.message : e}`);
}
JS

action_cache() {   # <uses> — resolve once, keeping the output for assertions
  node "$TMP/action-cache.mjs" "$PWD/dist" "$1" "$ACTION_CACHE" "$2" > "$TMP/action-cache.out" 2>&1 || {
    echo "FAIL: resolving $2 threw"; cat "$TMP/action-cache.out"; exit 1; }
}
cache_has() {      # <desc> <pattern>
  grep -q -e "$2" "$TMP/action-cache.out" || {
    echo "FAIL: $1 (pattern not found: $2)"; cat "$TMP/action-cache.out"; exit 1; }
  PASS=$((PASS+1)); echo "ok: $1"
}

action_cache "$FORGE_URL" 'acme/widget@main'
cache_has "a first resolve downloads the action" '^log=Downloading acme/widget@main ([0-9a-f]\{12\})$'
cache_has "the cache key names the commit" '^key=acme__widget__main__[0-9a-f]\{12\}$'

action_cache "$FORGE_URL" 'acme/widget@main'
cache_has "a second resolve reuses the download, and says so" '^log=Using cached acme/widget@main'

# The point of keying by commit: a branch that moved is picked up on the next
# job rather than a day later.
cat > "$ACTION_SRC/action.yml" <<'YML'
name: widget-two
description: An action at its second commit
runs:
  using: composite
  steps: []
YML
git -C "$ACTION_SRC" -c user.email=ci@example.com -c user.name=ci commit -qam two
git -C "$ACTION_SRC" push -q "$FORGE/acme/widget" main
forge_publish

action_cache "$FORGE_URL" 'acme/widget@main'
cache_has "a moved branch is fetched again at once" '^log=Downloading acme/widget@main'
cache_has "the new commit is what the job gets" '^name=widget-two$'
[ "$(ls "$ACTION_CACHE" | grep -c '^acme__widget__main__')" = 1 ] || {
  echo "FAIL: the superseded cache entry was not pruned"; ls "$ACTION_CACHE"; exit 1; }
PASS=$((PASS+1)); echo "ok: the entry a branch pointed at before is pruned when it moves"

action_cache "$FORGE_URL" 'acme/widget@v1'
cache_has "an annotated tag resolves to the commit it points at" '^name=widget-one$'

NO_ACTION_CACHE=1 action_cache "$FORGE_URL" 'acme/widget@main'
cache_has "the cache can be turned off" '^log=Downloading acme/widget@main .*(cache disabled)$'

# A forge that cannot answer ls-remote still works, by name, as before.
action_cache "$FORGE_URL/byname" 'acme/widget@main'
cache_has "an unresolvable ref falls back to keying by name, and says so" '^log=Could not resolve acme/widget@main'
cache_has "the fallback key is the ref name" '^key=acme__widget__main$'
cache_has "the fallback still delivers the action" '^name=widget-two$'

kill "$FORGE_PID" 2>/dev/null || true
FORGE_PID=""

# ---- executing a job (needs Docker) ----

if command -v docker > /dev/null 2>&1 && docker version --format '{{.Server.Version}}' > /dev/null 2>&1; then
  CI_IMAGE="${SMOKE_CI_IMAGE:-ubuntu:24.04}"
  check "actions page for a fresh dispatch" 200 -b "$JAR" "$BASE/demo/ci/actions"
  CSRF="$(csrf_of)"
  check "dispatch the build workflow to run for real" 302 -b "$JAR" "$BASE/demo/ci/actions/dispatch" \
    --data-urlencode "csrf=$CSRF" --data-urlencode "workflow=.github/workflows/build.yml" \
    --data-urlencode ref=main
  EXEC_RUN="$(runs_named 'Build' | awk '{print $NF}')"
  node dist/index.js runner run --host "$BASE" --runner-token "$RUNNER_TOKEN" \
    --image "ubuntu-latest=$CI_IMAGE" > "$TMP/runner.log" 2>&1 &
  RUNNER_PID=$!
  for _ in $(seq 1 120); do
    [ "$(run_field "$RUNS/$EXEC_RUN/run.json" status)" = "completed" ] && break
    sleep 1
  done
  kill "$RUNNER_PID" 2>/dev/null || true
  wait "$RUNNER_PID" 2>/dev/null || true
  [ "$(run_field "$RUNS/$EXEC_RUN/run.json" status)" = "completed" ] || {
    echo "FAIL: the dispatched run never completed"; cat "$TMP/runner.log"; exit 1; }
  PASS=$((PASS+1)); echo "ok: a runner executed the run to completion"
  [ "$(job_field "$RUNS/$EXEC_RUN/jobs/build.json" conclusion)" = "success" ] || {
    echo "FAIL: the build job did not succeed"; cat "$RUNS/$EXEC_RUN/jobs/build.log"; exit 1; }
  PASS=$((PASS+1)); echo "ok: run: steps execute in a container and succeed"
  grep -q '"version": "1.2.3"' "$RUNS/$EXEC_RUN/jobs/build.json" || {
    echo "FAIL: the job output was not captured from GITHUB_OUTPUT"; exit 1; }
  PASS=$((PASS+1)); echo "ok: GITHUB_OUTPUT feeds step and job outputs"
  grep -q 'version is 1.2.3' "$RUNS/$EXEC_RUN/jobs/build.log" || {
    echo "FAIL: a step did not see an earlier step's output"; exit 1; }
  PASS=$((PASS+1)); echo "ok: steps.<id>.outputs resolves in a later step"
  grep -q 'greeting=from-workflow' "$RUNS/$EXEC_RUN/jobs/build.log" || {
    echo "FAIL: workflow env did not reach the step"; exit 1; }
  PASS=$((PASS+1)); echo "ok: workflow-level env reaches a step"
  [ "$(job_field "$RUNS/$EXEC_RUN/jobs/fan-1.json" conclusion)" = "success" ] || {
    echo "FAIL: fan-1 did not succeed"; exit 1; }
  [ "$(job_field "$RUNS/$EXEC_RUN/jobs/fan-2.json" conclusion)" = "failure" ] || {
    echo "FAIL: fan-2 did not fail as its workflow says it should"; exit 1; }
  PASS=$((PASS+1)); echo "ok: matrix jobs run independently and fail independently"
  grep -q 'n=1 version=1.2.3' "$RUNS/$EXEC_RUN/jobs/fan-1.log" || {
    echo "FAIL: needs.<job>.outputs did not reach the dependent job"; exit 1; }
  PASS=$((PASS+1)); echo "ok: needs outputs reach a dependent job"
  [ "$(run_field "$RUNS/$EXEC_RUN/run.json" conclusion)" = "failure" ] || {
    echo "FAIL: a run with a failed job did not conclude as failure"; exit 1; }
  PASS=$((PASS+1)); echo "ok: one failed job fails the run"

  check "run page shows step logs" 200 "$BASE/demo/ci/actions/runs/$EXEC_RUN?job=build"
  body_has "step names on the run page" 'Use the output'
  body_has "step output in the rendered log" 'version is 1.2.3'
  check "the run page defaults to the failed job" 200 "$BASE/demo/ci/actions/runs/$EXEC_RUN"
  body_has "matrix job name resolved" 'fan (2)'


  # ---- actions: local JavaScript and composite actions ----
  #
  # Local actions keep these checks offline. Resolving an action from a forge
  # is exercised separately, and skipped when there is no network.

  mkdir -p "$CI_REPO/.github/actions/js-hello" "$CI_REPO/.github/actions/greet"
  cat > "$CI_REPO/.github/actions/js-hello/action.yml" <<'YML'
name: JS hello
description: A JavaScript action
inputs:
  who:
    description: Who to greet
    required: true
runs:
  using: node20
  main: index.js
  post: cleanup.js
YML
  cat > "$CI_REPO/.github/actions/js-hello/index.js" <<'JS'
const fs = require('fs');
console.log(`hello ${process.env.INPUT_WHO} from node ${process.version}`);
console.log(`action path is ${process.env.GITHUB_ACTION_PATH}`);
fs.appendFileSync(process.env.GITHUB_OUTPUT, `message=hello ${process.env.INPUT_WHO}\n`);
fs.appendFileSync(process.env.GITHUB_ENV, `FROM_JS=set-by-the-js-action\n`);
JS
  cat > "$CI_REPO/.github/actions/js-hello/cleanup.js" <<'JS'
console.log('the js action post step ran');
JS
  cat > "$CI_REPO/.github/actions/greet/action.yml" <<'YML'
name: Greet
description: A composite action
inputs:
  who:
    description: Who to greet
    default: nobody
outputs:
  greeting:
    description: What was said
    value: ${{ steps.say.outputs.text }}
runs:
  using: composite
  steps:
    - id: say
      shell: bash
      run: |
        echo "composite greeting ${{ inputs.who }}"
        echo "text=hello ${{ inputs.who }}" >> "$GITHUB_OUTPUT"
    - shell: bash
      run: test -f "$GITHUB_ACTION_PATH/action.yml" && echo "action path is right"
    - uses: ./.github/actions/js-hello
      with:
        who: nested
YML
  cat > "$CI_REPO/.github/workflows/actions.yml" <<'YML'
name: Actions
on: workflow_dispatch
jobs:
  act:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - id: js
        uses: ./.github/actions/js-hello
        with:
          who: world
      - run: |
          echo "js said '${{ steps.js.outputs.message }}'"
          echo "FROM_JS=$FROM_JS"
      - id: comp
        uses: ./.github/actions/greet
        with:
          who: everyone
      - run: echo "composite output '${{ steps.comp.outputs.greeting }}'"
      - uses: ./.github/actions/nonexistent
        continue-on-error: true
      - run: echo "continued past a missing action"
YML

  # ---- artifacts and the site ----
  cat > "$CI_REPO/.github/workflows/site.yml" <<'YML'
name: Site
on: workflow_dispatch
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: |
          mkdir -p _site/css
          echo "<h1>built by a workflow</h1>" > _site/index.html
          echo "body{}" > _site/css/style.css
      - uses: actions/configure-pages@v5
      - run: echo "base path is $HUBBIT_SITE_BASE_PATH (was $HUBBIT_PAGES_BASE_PATH)"
      - uses: actions/upload-artifact@v4
        with:
          name: site
          path: _site
  deploy:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: site
          path: incoming
      - run: test -f incoming/index.html && test -f incoming/css/style.css && echo "the artifact round-tripped"
YML

  git -C "$CI_REPO" add -A
  git -C "$CI_REPO" -c user.email=ci@example.com -c user.name=ci commit -qm "Add action and artifact workflows"
  git -C "$CI_REPO" push -q "http://owner:$OWNER_TOKEN@127.0.0.1:$PORT/demo/ci" main
  sleep 1

  # Dispatch a workflow, run it to completion with one runner, and leave the
  # run number in RUN_N. It cannot return the number on stdout, since the
  # checks it performs print there too.
  run_workflow() {
    local wf="$1" name="$2"
    check "actions page before dispatching $wf" 200 -b "$JAR" "$BASE/demo/ci/actions"
    CSRF="$(csrf_of)"
    check "dispatch $wf" 302 -b "$JAR" "$BASE/demo/ci/actions/dispatch" \
      --data-urlencode "csrf=$CSRF" --data-urlencode "workflow=.github/workflows/$wf" \
      --data-urlencode ref=main
    RUN_N="$(runs_named "$name" | awk '{print $NF}')"
    [ -n "$RUN_N" ] || { echo "FAIL: dispatching $wf planned no run"; exit 1; }
    node dist/index.js runner run --host "$BASE" --runner-token "$RUNNER_TOKEN" \
      --image "ubuntu-latest=$CI_IMAGE" --cache-dir "$TMP/runner-cache" >> "$TMP/runner.log" 2>&1 &
    RUNNER_PID=$!
    local i
    for i in $(seq 1 240); do
      [ "$(run_field "$RUNS/$RUN_N/run.json" status)" = "completed" ] && break
      sleep 1
    done
    kill "$RUNNER_PID" 2>/dev/null || true
    wait "$RUNNER_PID" 2>/dev/null || true
    [ "$(run_field "$RUNS/$RUN_N/run.json" status)" = "completed" ] || {
      echo "FAIL: run #$RUN_N ($name) never completed"; tail -40 "$TMP/runner.log"; exit 1; }
  }

  run_workflow actions.yml Actions
  ACT_RUN="$RUN_N"
  ACT_LOG="$RUNS/$ACT_RUN/jobs/act.log"
  grep -q "already checked out" "$ACT_LOG" || {
    echo "FAIL: actions/checkout was not substituted"; exit 1; }
  PASS=$((PASS+1)); echo "ok: actions/checkout is substituted by hubbit's own"
  grep -q "hello world from node v20" "$ACT_LOG" || {
    echo "FAIL: the JavaScript action did not run on node 20"; cat "$ACT_LOG"; exit 1; }
  PASS=$((PASS+1)); echo "ok: a JavaScript action runs, on the node version it asks for"
  grep -q "js said 'hello world'" "$ACT_LOG" || {
    echo "FAIL: the action's GITHUB_OUTPUT did not reach a later step"; exit 1; }
  PASS=$((PASS+1)); echo "ok: an action's outputs reach a later step"
  grep -q "FROM_JS=set-by-the-js-action" "$ACT_LOG" || {
    echo "FAIL: the action's GITHUB_ENV did not reach a later step"; exit 1; }
  PASS=$((PASS+1)); echo "ok: an action's GITHUB_ENV reaches a later step"
  grep -q "composite greeting everyone" "$ACT_LOG" || {
    echo "FAIL: the composite action's steps did not run"; exit 1; }
  grep -q "action path is right" "$ACT_LOG" || {
    echo "FAIL: GITHUB_ACTION_PATH was wrong inside a composite action"; exit 1; }
  PASS=$((PASS+1)); echo "ok: a composite action runs with its inputs and its own directory"
  grep -q "hello nested from node" "$ACT_LOG" || {
    echo "FAIL: an action nested inside a composite action did not run"; exit 1; }
  PASS=$((PASS+1)); echo "ok: an action nested inside a composite action runs"
  grep -q "composite output 'hello everyone'" "$ACT_LOG" || {
    echo "FAIL: the composite action's outputs did not resolve"; exit 1; }
  PASS=$((PASS+1)); echo "ok: a composite action's outputs resolve for the caller"
  grep -q "the js action post step ran" "$ACT_LOG" || {
    echo "FAIL: the action's post step did not run"; exit 1; }
  PASS=$((PASS+1)); echo "ok: an action's post step runs after the job's steps"
  grep -q "continued past a missing action" "$ACT_LOG" || {
    echo "FAIL: continue-on-error did not apply to a failing action step"; exit 1; }
  PASS=$((PASS+1)); echo "ok: a missing action fails its step, and continue-on-error still applies"
  [ "$(job_field "$RUNS/$ACT_RUN/jobs/act.json" conclusion)" = "success" ] || {
    echo "FAIL: the actions job did not succeed"; cat "$ACT_LOG"; exit 1; }
  PASS=$((PASS+1)); echo "ok: the whole actions job succeeds"

  run_workflow site.yml Site
  SITE_RUN="$RUN_N"
  [ -f "$RUNS/$SITE_RUN/artifacts/site.tar" ] || {
    echo "FAIL: the artifact was not stored in the run directory"; exit 1; }
  PASS=$((PASS+1)); echo "ok: upload-artifact stores an artifact in the vault"
  grep -q "the artifact round-tripped" "$RUNS/$SITE_RUN/jobs/deploy.log" || {
    echo "FAIL: download-artifact did not restore the files"
    cat "$RUNS/$SITE_RUN/jobs/deploy.log"; exit 1; }
  PASS=$((PASS+1)); echo "ok: download-artifact restores an artifact in a later job"
  grep -q "base path is /demo/ci/site (was /demo/ci/site)" "$RUNS/$SITE_RUN/jobs/build.log" || {
    echo "FAIL: configure-pages reported the wrong base path"; exit 1; }
  PASS=$((PASS+1)); echo "ok: configure-pages reports the vault's own site path, under both variable names"
  check "the artifact is listed on the run page" 200 "$BASE/demo/ci/actions/runs/$SITE_RUN"
  body_has "artifact name shown" 'site'
  check "the artifact downloads" 200 "$BASE/demo/ci/actions/runs/$SITE_RUN/artifacts/site"
  check "an unknown artifact is 404" 404 "$BASE/demo/ci/actions/runs/$SITE_RUN/artifacts/nosuch"

  # Deploying a site needs the real upload-pages-artifact action, which is
  # fetched from a forge; skip when there is no network rather than failing.
  if curl -sS --max-time 10 -o /dev/null "https://github.com" 2>/dev/null; then
    cat > "$CI_REPO/.github/workflows/deploy.yml" <<'YML'
name: Deploy
on: workflow_dispatch
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: |
          mkdir -p _site
          echo "<h1>deployed by a workflow</h1>" > _site/index.html
      - uses: actions/upload-pages-artifact@v3
        with:
          path: _site
  deploy:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
      - run: echo "page url is ${{ steps.deployment.outputs.page_url }}"
YML
    git -C "$CI_REPO" add -A
    git -C "$CI_REPO" -c user.email=ci@example.com -c user.name=ci commit -qm "Add a site deployment workflow"
    git -C "$CI_REPO" push -q "http://owner:$OWNER_TOKEN@127.0.0.1:$PORT/demo/ci" main
    sleep 1
    run_workflow deploy.yml Deploy
    DEPLOY_RUN="$RUN_N"
    [ "$(run_field "$RUNS/$DEPLOY_RUN/run.json" conclusion)" = "success" ] || {
      echo "FAIL: the site deployment run did not succeed"
      cat "$RUNS/$DEPLOY_RUN/jobs/build.log" "$RUNS/$DEPLOY_RUN/jobs/deploy.log"; exit 1; }
    PASS=$((PASS+1)); echo "ok: a real upload-pages-artifact and deploy-pages run to completion"
    [ -f "$VAULT/demo/ci.site/index.html" ] || {
      echo "FAIL: the site was not written to the site directory"; exit 1; }
    PASS=$((PASS+1)); echo "ok: deploy-pages published the artifact as the repository's site"
    check "the deployed site is served" 200 "$BASE/demo/ci/site/"
    body_has "the deployed content" 'deployed by a workflow'
    check "a remote action was fetched and cached" 200 "$BASE/demo/ci/actions/runs/$DEPLOY_RUN"
    [ -d "$TMP/runner-cache/actions" ] || { echo "FAIL: no action cache was written"; exit 1; }
    PASS=$((PASS+1)); echo "ok: actions fetched from a forge are cached on the runner"
  else
    echo "skip: no network; skipping the checks that fetch actions from a forge"
  fi

else
  echo "skip: docker is not available; skipping the job-execution checks"
fi

# ---- removing a runner ----

check "runners page for removal" 200 -b "$JAR" "$BASE/admin/runners"
CSRF="$(csrf_of)"
check "remove the runner" 302 -b "$JAR" "$BASE/admin/runners/smoke/remove" --data-urlencode "csrf=$CSRF"
check "the removed runner's token stops working" 401 -H "Authorization: Bearer $RUNNER_TOKEN" \
  "$BASE/api/runner/whoami"

# ---- deleting a repository takes its run history with it ----

check "settings for the ci repo" 200 -b "$JAR" "$BASE/demo/ci/settings"
CSRF="$(csrf_of)"
check "delete the ci repo" 302 -b "$JAR" "$BASE/demo/ci/settings/delete" \
  --data-urlencode "csrf=$CSRF" --data-urlencode confirm=demo/ci
[ ! -e "$VAULT/demo/ci.runs" ] || { echo "FAIL: .runs directory survived repository deletion"; exit 1; }
PASS=$((PASS+1)); echo "ok: repository deletion removed its run history"

# ---- repository deletion ----

check "settings for deletion" 200 -b "$JAR" "$BASE/demo/proj/settings"
CSRF="$(csrf_of)"
check "wrong confirm refused" 400 -b "$JAR" "$BASE/demo/proj/settings/delete" \
  --data-urlencode "csrf=$CSRF" --data-urlencode confirm=wrong
check "delete repo" 302 -b "$JAR" "$BASE/demo/proj/settings/delete" \
  --data-urlencode "csrf=$CSRF" --data-urlencode confirm=demo/proj
check "deleted repo is gone" 404 "$BASE/demo/proj"
[ ! -e "$VAULT/demo/proj.git" ] || { echo "FAIL: repo directory still on disk"; exit 1; }
PASS=$((PASS+1)); echo "ok: repo directory removed"

# ---- sign out ----

check "sign out" 302 -b "$JAR" -c "$JAR" "$BASE/logout" --data-urlencode "csrf=$CSRF"
check "signed out home" 200 -b "$JAR" "$BASE/"
body_has "sign-in link back" 'Sign in'

echo ""
echo "All $PASS smoke checks passed."
