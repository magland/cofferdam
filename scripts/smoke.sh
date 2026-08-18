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
body_lacks "pointer text not rendered as content" 'class="gutter"'
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
