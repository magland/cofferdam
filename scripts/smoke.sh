#!/usr/bin/env bash
# End-to-end smoke test: starts a server on a fresh vault and exercises
# browsing, sessions, UI operations, the JSON API, and git over HTTP.
# Run from the repository root: bash scripts/smoke.sh
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${SMOKE_PORT:-$((RANDOM % 2000 + 42000))}"
BASE="http://127.0.0.1:$PORT"
TMP="$(mktemp -d)"
VAULT="$TMP/vault"
LOG="$TMP/server.log"
JAR="$TMP/owner.jar"
ALICE_JAR="$TMP/alice.jar"
BODY="$TMP/body"
mkdir -p "$VAULT"

export GIT_TERMINAL_PROMPT=0

npm run build > /dev/null

SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
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

OWNER_TOKEN="$(grep -o 'doqpod_[0-9a-f]\{64\}' "$LOG" | head -1 || true)"
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
body_has "clone box present" 'git clone'
body_lacks "no collapsible cli hints" 'cmd-hint'

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
body_has "push is a mirror push" 'push --mirror'
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
body_lacks "no line gutter in the preview" 'class="gutter"'
check "markdown source view" 200 -b "$JAR" "$BASE/demo/proj/blob/main/docs/guide.md?plain=1"
body_has "source view has a line gutter" 'class="gutter"'
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
body_has "text file has a line gutter" 'class="gutter"'
body_lacks "no preview toggle on a text file" 'plain=1'

# ---- branches and tags ----

check "branches page" 200 -b "$JAR" "$BASE/demo/proj/branches"
CSRF="$(csrf_of)"
check "create branch" 302 -b "$JAR" "$BASE/demo/proj/branches/create" \
  --data-urlencode "csrf=$CSRF" --data-urlencode name=feature --data-urlencode from=main
check "branch listed" 200 -b "$JAR" "$BASE/demo/proj/branches"
body_has "feature branch shown" '>feature<'
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

# ---- settings ----

check "settings page" 200 -b "$JAR" "$BASE/demo/proj/settings"
CSRF="$(csrf_of)"
check "save settings" 302 -b "$JAR" "$BASE/demo/proj/settings" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "description=A refreshed description" \
  --data-urlencode defaultBranch=main
check "collection page shows description" 200 "$BASE/demo"
body_has "description updated" 'A refreshed description'

# ---- empty repository README flow ----

check "new repo form again" 200 -b "$JAR" "$BASE/new"
CSRF="$(csrf_of)"
check "create demo/bare without init" 302 -b "$JAR" "$BASE/new" \
  --data-urlencode "csrf=$CSRF" --data-urlencode collection=demo --data-urlencode name=bare
check "empty repo page" 200 -b "$JAR" "$BASE/demo/bare"
body_has "create README button" 'Create a README'
body_has "empty repo keeps clone command" 'git clone'
body_has "empty repo keeps push command" 'git push'
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
ALICE_TOKEN="$(grep -o 'doqpod_[0-9a-f]\{64\}' "$BODY" | head -1 || true)"
[ -n "$ALICE_TOKEN" ] || { echo "FAIL: no token for alice shown"; exit 1; }
check "grant to alice" 302 -b "$JAR" "$BASE/admin/users/alice/grant" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "scope=extra/thing" --data-urlencode "admin="
check "mint token for alice" 200 -b "$JAR" "$BASE/admin/users/alice/token" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "tokenScope="
body_has "minted token shown" 'doqpod_'

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
COLLECTION_TOKEN="$(grep -o 'doqpod_[0-9a-f]\{64\}' "$BODY" | head -1 || true)"
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

# ---- JSON API ----

check "api whoami" 200 -H "Authorization: Bearer $OWNER_TOKEN" "$BASE/api/whoami"
body_has "whoami username" '"username":"owner"'
check "api rejects session cookie" 401 -b "$JAR" "$BASE/api/whoami"

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

# ---- pages site ----

mkdir -p "$VAULT/pushed/created.pages"
echo '<h1>pages ok</h1>' > "$VAULT/pushed/created.pages/index.html"
check "pages site served" 200 "$BASE/pushed/created/pages/"
body_has "pages content" 'pages ok'

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
