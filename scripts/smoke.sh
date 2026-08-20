#!/usr/bin/env bash
# End-to-end smoke test: starts a server on a fresh vault and exercises
# browsing, sessions, UI operations, the JSON API, and git over HTTP.
# Run from the repository root: bash scripts/smoke.sh
set -euo pipefail

cd "$(dirname "$0")/.."

# The suite starts six servers over its life, on PORT and the five ports above
# it. Those ports have to sit below the kernel's ephemeral range (32768-60999 on
# Linux by default, and readable from /proc), because the suite opens thousands
# of outgoing connections and any of them can be given a port in that range as
# its source. A listening port picked from inside the range is then a race: the
# port is free when it is chosen and taken by a curl or a git fetch by the time a
# server binds it, which surfaces as an EADDRINUSE unrelated to anything under
# test. Each port of the block is also probed before use, since a port under the
# range may still belong to something else on the machine.
pick_port_block() {
  node -e '
    const net = require("net");
    const fs = require("fs");
    const span = 6;
    let low = 32768;
    try {
      const parsed = parseInt(fs.readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").split(/\s+/)[0], 10);
      if (parsed > 0) low = parsed;
    } catch {}
    const min = 20000;
    const max = Math.max(min + 1000, low - span);
    const free = (port) => new Promise((resolve) => {
      const probe = net.createServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
    });
    (async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const base = min + Math.floor(Math.random() * (max - min));
        let ok = true;
        for (let k = 0; k < span && ok; k++) ok = await free(base + k);
        if (ok) { console.log(base); return; }
      }
      process.exit(1);
    })();
  '
}
PORT="${SMOKE_PORT:-$(pick_port_block)}"
[ -n "$PORT" ] || { echo "FAIL: no free block of ports to run the servers on"; exit 1; }
BASE="http://127.0.0.1:$PORT"
# The scratch tree needs two things from its filesystem, and a container is
# not guaranteed to offer both:
#
#  - it must be able to execute a script, because git silently skips a hook it
#    cannot execute. git-lfs uploads objects from a pre-push hook, so on a
#    filesystem mounted noexec the LFS checks below see a pointer pushed, no
#    object uploaded, and a download that 404s, none of which is cofferdam's
#    doing. The vault lives here too, and its repositories have hooks of their
#    own.
#  - it should be able to keep a file private, because `git credential-store`
#    writes 0600 and one check asserts it. Some overlay and container mounts
#    force a mode (646, 666) whatever the umask.
#
# Executing wins when only one is on offer: it decides what the suite can test
# at all, while the other costs a single assertion, which is then skipped and
# says so. The function prints the directory and whether it is private, since
# a command substitution cannot hand back a variable.
smoke_tmp() {
  local base d mode exec_ok private_ok fallback=""
  for base in "${TMPDIR:-/tmp}" /dev/shm; do
    [ -d "$base" ] && [ -w "$base" ] || continue
    d="$(mktemp -d "$base/cofferdam-smoke.XXXXXX" 2>/dev/null)" || continue
    printf '#!/bin/sh\nexit 0\n' > "$d/probe.sh"; chmod +x "$d/probe.sh"
    if "$d/probe.sh" 2>/dev/null; then exec_ok=1; else exec_ok=0; fi
    ( umask 077; : > "$d/probe.mode" )
    mode="$(stat -c '%a' "$d/probe.mode" 2>/dev/null || stat -f '%Lp' "$d/probe.mode")"
    [ "$mode" = 600 ] && private_ok=1 || private_ok=0
    rm -f "$d/probe.sh" "$d/probe.mode"
    if [ "$exec_ok" = 1 ] && [ "$private_ok" = 1 ]; then printf '%s 1\n' "$d"; return 0; fi
    if [ "$exec_ok" = 1 ] && [ -z "$fallback" ]; then fallback="$d"; continue; fi
    rm -rf "$d"
  done
  if [ -n "$fallback" ]; then printf '%s 0\n' "$fallback"; return 0; fi
  echo "no writable directory that can execute a script (tried \$TMPDIR and /dev/shm); set TMPDIR to one" >&2
  return 1
}
read -r TMP TMP_PRIVATE <<<"$(smoke_tmp)"
[ -n "$TMP" ] || exit 1
VAULT="$TMP/vault"
LOG="$TMP/server.log"
JAR="$TMP/owner.jar"
ALICE_JAR="$TMP/alice.jar"
BODY="$TMP/body"
mkdir -p "$VAULT"

export GIT_TERMINAL_PROMPT=0

# Executing workflow jobs is the one part of this suite measured in minutes
# rather than seconds: each run pulls an image, starts a container per job, and
# is polled once a second until it finishes, which is around three of the three
# and a half minutes the whole suite takes. Everything else, planning included,
# runs against the local server and costs about twenty seconds together, so the
# execution checks are opt-in rather than routine:
#
#   npm run smoke        # everything but job execution
#   npm run smoke:slow   # that too (needs Docker)
SMOKE_SLOW="${SMOKE_SLOW:-0}"

# The suite tests cofferdam, not the machine's git configuration, and two of the
# checks below are only meaningful against a known one: "login refuses when no
# credential helper is configured" is false the moment a system config sets a
# helper, as a hosted development container does. An identity has to come from
# somewhere too, since several commits here do not pass one.
export GIT_CONFIG_SYSTEM=/dev/null
export GIT_CONFIG_GLOBAL="$TMP/gitconfig"
cat > "$GIT_CONFIG_GLOBAL" <<'GITCONFIG'
[user]
	name = cofferdam smoke
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
PRESET_PID=""
LIMIT_PID=""
BACKUP_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "$FORGE_PID" ] && kill "$FORGE_PID" 2>/dev/null || true
  [ -n "$PRESET_PID" ] && kill "$PRESET_PID" 2>/dev/null || true
  [ -n "${LIMIT_PID:-}" ] && kill "$LIMIT_PID" 2>/dev/null || true
  [ -n "${BACKUP_PID:-}" ] && kill "$BACKUP_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

# Two settings this suite needs from the vault before the server reads them, both
# of which are read once at startup.
#
#  - trustProxy, because several checks stand in for a reverse proxy with an
#    X-Forwarded-Proto header, and without it the server would rightly ignore
#    them. A vault with nothing in front wants the default, which is false.
#  - requestsPerMinute: 0, which disables the coarse per-address ceiling. This
#    suite sends every one of its several hundred requests from one address in
#    about twenty seconds, which is nothing like browsing and well past any
#    sensible limit. The limits are exercised deliberately further down, against
#    a second server started with a configuration of its own.
cat > "$VAULT/config.json" <<'CONFIG'
{
  "theme": "paper",
  "network": { "trustProxy": true },
  "limits": { "requestsPerMinute": 0 }
}
CONFIG

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

OWNER_TOKEN="$(grep -o 'cofferdam_[0-9a-f]\{64\}' "$LOG" | head -1 || true)"
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
header_has() {
  local desc="$1" pattern="$2"
  grep -qi -e "$pattern" "$TMP/headers" || { echo "FAIL: $desc (header not found: $pattern)"; cat "$TMP/headers"; exit 1; }
  PASS=$((PASS+1)); echo "ok: $desc"
}
header_lacks() {
  local desc="$1" pattern="$2"
  if grep -qi -e "$pattern" "$TMP/headers"; then echo "FAIL: $desc (header unexpectedly found: $pattern)"; cat "$TMP/headers"; exit 1; fi
  PASS=$((PASS+1)); echo "ok: $desc"
}
body_lacks() {
  local desc="$1" pattern="$2"
  if grep -q -e "$pattern" "$BODY"; then echo "FAIL: $desc (pattern unexpectedly found: $pattern)"; exit 1; fi
  PASS=$((PASS+1)); echo "ok: $desc"
}
# The stylesheet is every theme's palette followed by the structure, so asking
# about a colour in it means asking about one part of it. These two look only
# at the :root block, which is the vault's own theme and what a browser with no
# choice stored gets.
root_theme_has() {
  local desc="$1" pattern="$2"
  sed -n '/^:root {/,/^}/p' "$BODY" | grep -q -e "$pattern" \
    || { echo "FAIL: $desc (not in :root: $pattern)"; sed -n '/^:root {/,/^}/p' "$BODY"; exit 1; }
  PASS=$((PASS+1)); echo "ok: $desc"
}
root_theme_lacks() {
  local desc="$1" pattern="$2"
  if sed -n '/^:root {/,/^}/p' "$BODY" | grep -q -e "$pattern"; then
    echo "FAIL: $desc (unexpectedly in :root: $pattern)"; exit 1
  fi
  PASS=$((PASS+1)); echo "ok: $desc"
}
# And this looks only at the structure below the palettes, where a colour
# literal would mean a new theme could not be added by editing themes.ts alone.
structure_names_no_colour() {
  local found
  found="$(sed -n '/\/\* The scale\./,$p' "$BODY" | grep -niE '#[0-9a-fA-F]{3,8}\b|\brgba?\(' || true)"
  if [ -n "$found" ]; then
    echo "FAIL: the structural stylesheet names a colour directly"; echo "$found"; exit 1
  fi
  PASS=$((PASS+1)); echo "ok: the structure names no colour of its own"
}
# A repository is a bare repository plus the sibling directories it
# accumulates beside it: .site, .runs, .issues, .pulls, .releases. Renaming
# one must take all of them along and deleting one must take all of them away,
# or a repository later created under the old name inherits somebody else's
# issues and pull request numbers. Asking about the whole set by glob rather
# than naming each directory is deliberate: a check that names them dates the
# moment a sixth is added, which is how .pulls came to be missed by both.
dir_exists() {
  local desc="$1" dir="$2"
  [ -d "$dir" ] || { echo "FAIL: $desc (no such directory: $dir)"; exit 1; }
  PASS=$((PASS+1)); echo "ok: $desc"
}
no_trace_of() {
  local desc="$1" collection="$2" name="$3" left
  left="$(ls -d "$VAULT/collections/$collection/repos/$name" "$VAULT/collections/$collection/repos/$name."* 2>/dev/null || true)"
  if [ -n "$left" ]; then
    echo "FAIL: $desc (left behind in the vault:)"; echo "$left"; exit 1
  fi
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

# ---- renaming a file, and committing to a new branch, from the editor ----

check "edit form offers the path" 200 -b "$JAR" "$BASE/demo/proj/edit/main/README.md"
body_has "path field present" 'name="path"'
body_has "new branch choice present" 'name="newBranchWanted"'
CSRF="$(csrf_of)"; EXPECTED="$(expected_of)"
check "rename a file while editing" 302 -b "$JAR" "$BASE/demo/proj/edit/main/README.md" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "expected=$EXPECTED" \
  --data-urlencode "path=docs/README.md" --data-urlencode "content=# proj

Edited via the web interface.
" --data-urlencode "message=Move the README under docs"
check "the file is at its new path" 200 "$BASE/demo/proj/blob/main/docs/README.md"
check "the old path is gone" 404 "$BASE/demo/proj/blob/main/README.md"
check "edit the moved file" 200 -b "$JAR" "$BASE/demo/proj/edit/main/docs/README.md"
CSRF="$(csrf_of)"; EXPECTED="$(expected_of)"
check "rename back" 302 -b "$JAR" "$BASE/demo/proj/edit/main/docs/README.md" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "expected=$EXPECTED" \
  --data-urlencode "path=README.md" --data-urlencode "content=# proj

Edited via the web interface.
" --data-urlencode "message=Move the README back"
check "README is home again" 200 "$BASE/demo/proj/blob/main/README.md"

check "edit form again" 200 -b "$JAR" "$BASE/demo/proj/edit/main/README.md"
CSRF="$(csrf_of)"; EXPECTED="$(expected_of)"
check "commit to a new branch" 302 -D "$TMP/headers" -b "$JAR" "$BASE/demo/proj/edit/main/README.md" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "expected=$EXPECTED" \
  --data-urlencode "path=README.md" --data-urlencode "content=# proj

Edited on a branch.
" --data-urlencode "message=Edit on a branch" --data-urlencode "newBranchWanted=1" --data-urlencode "newBranch=web-edit"
grep -qi 'location:.*compare/main\.\.\.web-edit' "$TMP/headers" || { echo "FAIL: a new branch does not land on the comparison"; exit 1; }
PASS=$((PASS+1)); echo "ok: a new branch lands on the comparison"
check "the new branch has the edit" 200 "$BASE/demo/proj/blob/web-edit/README.md"
body_has "the branch carries the new content" 'Edited on a branch'
check "the old branch is untouched" 200 "$BASE/demo/proj/blob/main/README.md"
body_has "main still has its own content" 'Edited via the web interface'
check "a branch name already taken is refused" 409 -b "$JAR" "$BASE/demo/proj/edit/main/README.md" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "expected=$EXPECTED" --data-urlencode "content=x" \
  --data-urlencode "newBranchWanted=1" --data-urlencode "newBranch=web-edit"
check "an unnamed new branch is refused" 400 -b "$JAR" "$BASE/demo/proj/edit/main/README.md" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "expected=$EXPECTED" --data-urlencode "content=x" \
  --data-urlencode "newBranchWanted=1" --data-urlencode "newBranch="

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
check "duplicate create is a conflict" 409 -b "$JAR" "$BASE/demo/proj/new/main" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "expected=$EXPECTED" \
  --data-urlencode filename=docs/notes.md --data-urlencode content=dup --data-urlencode message=dup

check "delete confirm form" 200 -b "$JAR" "$BASE/demo/proj/delete/main/docs/notes.md"
CSRF="$(csrf_of)"; EXPECTED="$(expected_of)"
check "delete the file" 302 -b "$JAR" "$BASE/demo/proj/delete/main/docs/notes.md" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "expected=$EXPECTED" --data-urlencode "message="
check "deleted file is gone" 404 -b "$JAR" "$BASE/demo/proj/blob/main/docs/notes.md"

# ---- import page ----

# The page performs nothing: importing runs on the reader's machine, and what
# used to be a form here (a source URL, answered with a shell one-liner) is now
# a command they run, which is what actually does the work.
check "import page needs a session" 302 "$BASE/import"
check "import page" 200 -b "$JAR" "$BASE/import"
body_lacks "no form to fill in" 'name="src"'
body_has "the cli command is written out" 'cofferdam import https://github.com/owner/repo'
body_has "and the login that precedes it" "cofferdam login $BASE"
check "import page for a collection" 200 -b "$JAR" \
  --get "$BASE/import" --data-urlencode collection=demo
body_has "the command carries the collection" 'cofferdam import https://github.com/owner/repo demo'
body_has "a way back to the collection" 'href="/demo">Back to demo'
# The git commands stay below the cli one, for a machine with no Node on it.
body_has "clone is bare, not mirror" 'git clone --bare'
body_lacks "no mirror clone" 'clone --mirror'
# The clone is scratch: it must not land in whatever directory the command is
# pasted into, which is how a failed attempt leaves a bare repo in a work tree.
body_has "clone goes to a temporary directory" 'mktemp -d /tmp/import'
body_has "push is a mirror push" 'push --mirror'
# Without this the prompt goes to an editor's askpass dialog, and an unanswered
# dialog looks like a hang: git prints nothing after the clone and waits.
body_has "push prompts in the terminal" 'GIT_ASKPASS= git -C'
body_has "destination carries the username" "owner@"
check "import is a reserved repo name" 400 -b "$JAR" "$BASE/new" \
  --data-urlencode "csrf=$CSRF" --data-urlencode collection=demo --data-urlencode name=import

# ---- creating a collection with nothing in it ----

check "new collection form" 200 -b "$JAR" "$BASE/new/collection"
CSRF="$(csrf_of)"
[ -n "$CSRF" ] || { echo "FAIL: no csrf on /new/collection"; exit 1; }
check "create an empty collection" 302 -b "$JAR" "$BASE/new/collection" \
  --data-urlencode "csrf=$CSRF" --data-urlencode name=empties
check "the empty collection has a page" 200 "$BASE/empties"
body_has "and says it is empty" 'No repositories in this collection yet'
check "the empty collection is listed" 200 "$BASE/"
body_has "with no repositories in it" '<span>empties</span><span class="coll-count">0</span>'
check "creating it twice is refused" 409 -b "$JAR" "$BASE/new/collection" \
  --data-urlencode "csrf=$CSRF" --data-urlencode name=empties
check "a reserved collection name is refused" 400 -b "$JAR" "$BASE/new/collection" \
  --data-urlencode "csrf=$CSRF" --data-urlencode name=admin
check "a collection needs a csrf value" 403 -b "$JAR" "$BASE/new/collection" \
  --data-urlencode name=nocsrf
check "anonymous new collection redirects to login" 302 "$BASE/new/collection"

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

# ---- uploading files ----

check "anonymous upload form redirects to login" 302 "$BASE/demo/proj/upload/main"
check "upload form" 200 -b "$JAR" "$BASE/demo/proj/upload/main"
body_has "upload form posts multipart" 'enctype="multipart/form-data"'
CSRF="$(csrf_of)"; EXPECTED="$(expected_of)"
printf 'uploaded through the web\n' > "$TMP/upload.txt"
printf '\x89PNG\r\n\x1a\n\x00\x01\x02\x03' > "$TMP/upload.bin"
check "upload two files" 302 -b "$JAR" "$BASE/demo/proj/upload/main" \
  -F "csrf=$CSRF" -F "expected=$EXPECTED" -F "message=Add files by upload" \
  -F "files=@$TMP/upload.txt" -F "files=@$TMP/upload.bin"
check "the uploaded text file is there" 200 "$BASE/demo/proj/raw/main/upload.txt"
body_has "its contents survived" 'uploaded through the web'
check "the uploaded binary is there" 200 -o "$TMP/back.bin" "$BASE/demo/proj/raw/main/upload.bin"
cmp -s "$TMP/upload.bin" "$BODY" || { echo "FAIL: the uploaded binary did not round-trip"; exit 1; }
PASS=$((PASS+1)); echo "ok: the uploaded binary round-trips byte for byte"
check "one commit for the pair" 200 "$BASE/demo/proj/commits/main"
body_has "the upload commit is named" 'Add files by upload'
check "upload form again" 200 -b "$JAR" "$BASE/demo/proj/upload/main"
CSRF="$(csrf_of)"; EXPECTED="$(expected_of)"
check "an upload with no files is refused" 400 -b "$JAR" "$BASE/demo/proj/upload/main" \
  -F "csrf=$CSRF" -F "expected=$EXPECTED" -F "message=nothing"
check "an upload with a bad csrf is refused" 403 -b "$JAR" "$BASE/demo/proj/upload/main" \
  -F "csrf=bogus" -F "expected=$EXPECTED" -F "files=@$TMP/upload.txt"
check "upload into a subdirectory" 302 -b "$JAR" "$BASE/demo/proj/upload/main/docs" \
  -F "csrf=$CSRF" -F "expected=$EXPECTED" -F "message=Add a file under docs" -F "files=@$TMP/upload.txt"
check "the file landed in the subdirectory" 200 "$BASE/demo/proj/raw/main/docs/upload.txt"

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
check "filter issues by label" 200 "$BASE/demo/proj/issues?state=all&label=bug"
body_has "the labelled issue is listed" 'Something is still wrong'
check "filter by a label nothing carries" 200 "$BASE/demo/proj/issues?state=all&label=nosuchlabel"
body_has "an empty filter says so" 'No issues match that'
check "filter issues by author" 200 "$BASE/demo/proj/issues?state=all&author=owner"
body_has "the author's issue is listed" 'Something is still wrong'
check "filter issues by someone else" 200 "$BASE/demo/proj/issues?state=all&author=nobody"
body_has "nothing from a stranger" 'No issues match that'
check "search issue text" 200 "$BASE/demo/proj/issues?state=all&q=startup"
body_has "the search found the body" 'Something is still wrong'
check "search for what is not there" 200 "$BASE/demo/proj/issues?state=all&q=zzzznotpresent"
body_has "an empty search says so" 'No issues match that'
check "sort issues" 200 "$BASE/demo/proj/issues?state=all&sort=oldest"
body_has "sorting keeps the filter links" 'sort=oldest'
check "unknown issue 404s" 404 "$BASE/demo/proj/issues/99"
check "non-numeric issue 404s" 404 "$BASE/demo/proj/issues/nope"
ISSUE_FILE="$VAULT/collections/demo/repos/proj.issues/1/issue.md"
[ -f "$ISSUE_FILE" ] || { echo "FAIL: issue not on disk at $ISSUE_FILE"; exit 1; }
grep -q '^title: Something is still wrong$' "$ISSUE_FILE" || { echo "FAIL: issue file has no title header"; exit 1; }
[ -f "$VAULT/collections/demo/repos/proj.issues/1/comments/1.md" ] || { echo "FAIL: comment not on disk"; exit 1; }
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
dir_exists "the issue directory moved to the new collection" "$VAULT/collections/moved/repos/proj.issues"
no_trace_of "nothing of the repository is left in the old collection" demo proj
check "move it back" 302 -b "$JAR" "$BASE/moved/proj/settings/rename" \
  --data-urlencode "csrf=$CSRF" --data-urlencode collection=demo --data-urlencode name=proj
check "back at its old address" 200 "$BASE/demo/proj"

# ---- renaming a collection ----

check "a collection to rename" 302 -b "$JAR" "$BASE/new" \
  --data-urlencode "csrf=$CSRF" --data-urlencode collection=oldname --data-urlencode name=thing \
  --data-urlencode init=1
check "the collection page" 200 -b "$JAR" "$BASE/oldname"
body_has "it offers its settings" 'href="/oldname/settings"'
check "anonymous sees the collection" 200 "$BASE/oldname"
body_lacks "but no settings link" 'href="/oldname/settings"'
check "anonymous collection settings redirect to login" 302 "$BASE/oldname/settings"
check "collection settings page" 200 -b "$JAR" "$BASE/oldname/settings"
body_has "it offers a rename" 'action="/oldname/settings/rename"'
body_has "it says what moves with the collection" 'moves with it'
check "rename the collection" 302 -b "$JAR" "$BASE/oldname/settings/rename" \
  --data-urlencode "csrf=$CSRF" --data-urlencode name=newname
check "the new name serves the collection" 200 "$BASE/newname"
check "and the repository in it" 200 "$BASE/newname/thing"
check "the old name is gone" 404 "$BASE/oldname"
dir_exists "the repository moved with the collection" "$VAULT/collections/newname/repos/thing.git"
[ -d "$VAULT/collections/oldname" ] && { echo "FAIL: the old collection directory is still there"; exit 1; }
PASS=$((PASS+1)); echo "ok: nothing is left under the old collection name"
check "renaming onto an existing collection is refused" 409 -b "$JAR" "$BASE/newname/settings/rename" \
  --data-urlencode "csrf=$CSRF" --data-urlencode name=demo
check "renaming a collection to its own name is refused" 400 -b "$JAR" "$BASE/newname/settings/rename" \
  --data-urlencode "csrf=$CSRF" --data-urlencode name=newname
check "a reserved collection name is refused" 400 -b "$JAR" "$BASE/newname/settings/rename" \
  --data-urlencode "csrf=$CSRF" --data-urlencode name=settings
check "settings for a collection that is not there 404s" 404 -b "$JAR" "$BASE/nosuch/settings"
check "an empty collection to rename" 302 -b "$JAR" "$BASE/new/collection" \
  --data-urlencode "csrf=$CSRF" --data-urlencode name=emptyold
check "rename the empty collection" 302 -b "$JAR" "$BASE/emptyold/settings/rename" \
  --data-urlencode "csrf=$CSRF" --data-urlencode name=emptynew
check "the renamed empty collection serves" 200 "$BASE/emptynew"

# ---- forking inside the vault ----

check "anonymous fork form redirects to login" 302 "$BASE/demo/proj/fork"
check "fork form" 200 -b "$JAR" "$BASE/demo/proj/fork"
body_has "fork form names the source" 'Fork demo/proj'
check "fork the repository" 302 -b "$JAR" "$BASE/demo/proj/fork" \
  --data-urlencode "csrf=$CSRF" --data-urlencode collection=forks --data-urlencode name=proj
check "the fork serves" 200 "$BASE/forks/proj"
body_has "the fork says where it came from" 'forked from'
body_has "the fork links its parent" 'href="/demo/proj"'
check "the fork carries the history" 200 "$BASE/forks/proj/commits/main"
body_has "history came across" 'Edit README from the web'
check "forking onto an existing repository is refused" 409 -b "$JAR" "$BASE/demo/proj/fork" \
  --data-urlencode "csrf=$CSRF" --data-urlencode collection=forks --data-urlencode name=proj
grep -q 'forkedFrom = demo/proj' "$VAULT/collections/forks/repos/proj.git/config" || { echo "FAIL: the fork does not record its parent"; exit 1; }
grep -q 'url = ' "$VAULT/collections/forks/repos/proj.git/config" && { echo "FAIL: the fork kept an origin remote pointing at a path"; exit 1; }
PASS=$((PASS+2)); echo "ok: the fork records its parent and keeps no origin"

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

# ---- names a new repository may not take ----

# A repository keeps its site, runs, issues, pulls and releases in sibling
# directories named after it, so a repository named `bare.issues` would occupy
# the path `bare`'s issues live at. Reading is unaffected: this is a refusal at
# creation, and a vault that already contains such a name keeps serving it.

check "new repo form for reserved names" 200 -b "$JAR" "$BASE/new"
CSRF="$(csrf_of)"
# `ghost` names no repository, so any demo/ghost.* directory appearing here
# would be one this refusal was supposed to prevent. (demo/bare.git could not
# serve as the example: that directory is the repository `bare` itself.)
for suffix in site runs issues pulls releases lfs git; do
  check "a repository may not be named .$suffix" 400 -b "$JAR" "$BASE/new" \
    --data-urlencode "csrf=$CSRF" --data-urlencode collection=demo --data-urlencode "name=ghost.$suffix"
  body_has "the refusal names the .$suffix suffix" "may not end in .$suffix"
  [ ! -e "$VAULT/collections/demo/repos/ghost.$suffix" ] || { echo "FAIL: demo/ghost.$suffix was created anyway"; exit 1; }
  PASS=$((PASS+1)); echo "ok: nothing was created for demo/ghost.$suffix"
done
# The refusal is about the ending, not about dots: a name that merely contains
# one of these words is ordinary.
check "a dot inside a name is still fine" 302 -b "$JAR" "$BASE/new" \
  --data-urlencode "csrf=$CSRF" --data-urlencode collection=demo --data-urlencode name=my.site.thing
check "the dotted repository is there" 200 "$BASE/demo/my.site.thing"

# ---- user administration ----

check "admin users page" 200 -b "$JAR" "$BASE/admin/users"
CSRF="$(csrf_of)"
check "create user alice" 200 -b "$JAR" "$BASE/admin/users" \
  --data-urlencode "csrf=$CSRF" --data-urlencode username=alice --data-urlencode "scope=demo/*" \
  --data-urlencode "admin="
ALICE_TOKEN="$(grep -o 'cofferdam_[0-9a-f]\{64\}' "$BODY" | head -1 || true)"

# A second user whose scope reaches nothing that exists, for the half of the
# authorization checks that need a token which may read but not write. alice has
# demo/* and so cannot stand in for it everywhere.
check "create user narrow" 200 -b "$JAR" "$BASE/admin/users" \
  --data-urlencode "csrf=$CSRF" --data-urlencode username=narrow \
  --data-urlencode "scope=nowhere/*" --data-urlencode "admin="
NARROW_TOKEN="$(grep -o 'cofferdam_[0-9a-f]\{64\}' "$BODY" | head -1 || true)"
[ -n "$NARROW_TOKEN" ] || { echo "FAIL: no token for the narrow user"; exit 1; }
PASS=$((PASS+1)); echo "ok: a token that may read everything and write nothing"
[ -n "$ALICE_TOKEN" ] || { echo "FAIL: no token for alice shown"; exit 1; }
check "grant to alice" 302 -b "$JAR" "$BASE/admin/users/alice/grant" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "scope=extra/thing" --data-urlencode "admin="
check "mint token for alice" 200 -b "$JAR" "$BASE/admin/users/alice/token" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "tokenScope="
body_has "minted token shown" 'cofferdam_'

# ---- revoking one token ends the sessions it started, and no others ----

# A session is bound to the token it was signed in with, so deleting that token
# from vault.json ends it. The interesting half is the other one: deleting a
# different token of the same user must leave the session alone, which is what
# a fix that simply counted the user's tokens would get wrong. This uses a user
# of its own, since it ends by taking all of that user's tokens away.

REV_JAR="$TMP/revoked.jar"
check "create user revoked" 200 -b "$JAR" "$BASE/admin/users" \
  --data-urlencode "csrf=$CSRF" --data-urlencode username=revoked --data-urlencode "scope=demo/*" \
  --data-urlencode "admin="
REV_ONE="$(grep -o 'cofferdam_[0-9a-f]\{64\}' "$BODY" | head -1 || true)"
# Three tokens, because the interesting deletion has to leave one behind: a
# user down to no tokens at all was already cut off before sessions were bound
# to a token, so a test that deletes them all proves nothing.
check "mint a second token for revoked" 200 -b "$JAR" "$BASE/admin/users/revoked/token" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "tokenScope="
REV_TWO="$(grep -o 'cofferdam_[0-9a-f]\{64\}' "$BODY" | head -1 || true)"
check "mint a third token for revoked" 200 -b "$JAR" "$BASE/admin/users/revoked/token" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "tokenScope="
REV_THREE="$(grep -o 'cofferdam_[0-9a-f]\{64\}' "$BODY" | head -1 || true)"
[ -n "$REV_ONE" ] && [ -n "$REV_TWO" ] && [ -n "$REV_THREE" ] &&
  [ "$REV_ONE" != "$REV_TWO" ] && [ "$REV_TWO" != "$REV_THREE" ] && [ "$REV_ONE" != "$REV_THREE" ] || {
  echo "FAIL: expected three distinct tokens for the revoked user"; exit 1; }
PASS=$((PASS+1)); echo "ok: the user holds three distinct tokens"

# Deletes one token by its hash, which is how vault.json stores it.
drop_token() {
  node -e '
    const fs = require("fs"), crypto = require("crypto");
    const [file, user, token] = process.argv.slice(1);
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    const before = v.users[user].tokens.length;
    v.users[user].tokens = v.users[user].tokens.filter((t) => (t.hash ?? t) !== hash);
    if (v.users[user].tokens.length !== before - 1) { console.error("no such token"); process.exit(1); }
    fs.writeFileSync(file, JSON.stringify(v, null, 2) + "\n");
  ' "$VAULT/vault.json" "$1" "$2" || { echo "FAIL: could not delete the token"; exit 1; }
}

check "sign in with the first token" 302 -c "$REV_JAR" "$BASE/login" \
  --data-urlencode username=revoked --data-urlencode "token=$REV_ONE" --data-urlencode next=/
check "the session works" 200 -b "$REV_JAR" "$BASE/demo/proj/edit/main/README.md"

drop_token revoked "$REV_TWO"
check "deleting another token leaves the session alone" 200 -b "$REV_JAR" "$BASE/demo/proj/edit/main/README.md"

# REV_THREE survives this, so the user still holds a token and the session ends
# because the token behind it went, not because the user ran out.
drop_token revoked "$REV_ONE"
check "deleting its own token ends the session" 302 -b "$REV_JAR" "$BASE/demo/proj/edit/main/README.md"
check "and the token no longer authenticates the API" 401 \
  -H "authorization: Bearer $REV_ONE" "$BASE/api/whoami"
check "the user's surviving token still works" 200 \
  -H "authorization: Bearer $REV_THREE" "$BASE/api/whoami"

# ---- themes ----

check "default theme is not github" 200 "$BASE/"
body_has "default theme linked" 'style.css?t=paper'
check "themed stylesheet" 200 "$BASE/assets/style.css?t=paper"
body_has "theme variables emitted" '--accent:'
# Every theme's palette ships in the one stylesheet, so a reader switching
# appearance changes an attribute rather than fetching a sheet. The vault's own
# theme is the one at :root, which is what an unset browser gets.
body_has "the vault's theme is the one at the root" ':root {'
body_has "and the others ship under their own attribute" '\[data-theme="github"\] {'
root_theme_has "the root is the vault's teal, not github's blue" '#0f6466'
root_theme_lacks "which is the whole point of the root block" '#0969da'
structure_names_no_colour
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
root_theme_has "and it is the root's accent now, not merely present" '#0969da'
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
check "alice cannot fork out of scope" 403 -b "$ALICE_JAR" "$BASE/demo/proj/fork" \
  --data-urlencode "csrf=$ALICE_CSRF" --data-urlencode collection=other --data-urlencode name=proj
check "alice cannot rename repo" 403 -b "$ALICE_JAR" "$BASE/demo/proj/settings/rename" \
  --data-urlencode "csrf=$ALICE_CSRF" --data-urlencode collection=demo --data-urlencode name=nope
check "alice cannot delete repo" 403 -b "$ALICE_JAR" "$BASE/demo/proj/settings/delete" \
  --data-urlencode "csrf=$ALICE_CSRF" --data-urlencode confirm=demo/proj
check "alice cannot reach collection settings" 403 -b "$ALICE_JAR" "$BASE/demo/settings"
check "alice cannot rename a collection" 403 -b "$ALICE_JAR" "$BASE/demo/settings/rename" \
  --data-urlencode "csrf=$ALICE_CSRF" --data-urlencode name=nope
check "alice cannot import out of scope" 403 -b "$ALICE_JAR" \
  --get "$BASE/import" --data-urlencode collection=other
check "alice cannot create a collection out of scope" 403 -b "$ALICE_JAR" "$BASE/new/collection" \
  --data-urlencode "csrf=$ALICE_CSRF" --data-urlencode name=other

# ---- a delegated collection admin is an admin, but not for vault-wide settings ----

check "admin users page for delegation" 200 -b "$JAR" "$BASE/admin/users"
CSRF="$(csrf_of)"
check "create delegated admin" 200 -b "$JAR" "$BASE/admin/users" \
  --data-urlencode "csrf=$CSRF" --data-urlencode username=collectionadmin \
  --data-urlencode "scope=demo/*" --data-urlencode "admin=demo/*"
COLLECTION_TOKEN="$(grep -o 'cofferdam_[0-9a-f]\{64\}' "$BODY" | head -1 || true)"
[ -n "$COLLECTION_TOKEN" ] || { echo "FAIL: no token for collectionadmin"; exit 1; }
check "collectionadmin login" 302 -c "$TMP/collectionadmin.jar" "$BASE/login" \
  --data-urlencode username=collectionadmin --data-urlencode "token=$COLLECTION_TOKEN" --data-urlencode next=/
check "collectionadmin reaches admin index" 200 -b "$TMP/collectionadmin.jar" "$BASE/admin"
body_lacks "no appearance card for delegated admin" '/admin/appearance'
check "collectionadmin cannot open appearance" 403 -b "$TMP/collectionadmin.jar" "$BASE/admin/appearance"
check "collectionadmin cannot set the theme" 403 -b "$TMP/collectionadmin.jar" "$BASE/admin/appearance" \
  --data-urlencode "csrf=$CSRF" --data-urlencode theme=terminal
# Admin over demo/* is admin over the collection, so its settings are theirs to
# open; where a rename would land is a separate question, and their push scope
# does not reach outside demo.
check "collectionadmin reaches collection settings" 200 -b "$TMP/collectionadmin.jar" "$BASE/demo/settings"
CA_CSRF="$(csrf_of)"
check "collectionadmin cannot rename it out of their push scope" 403 -b "$TMP/collectionadmin.jar" \
  "$BASE/demo/settings/rename" --data-urlencode "csrf=$CA_CSRF" --data-urlencode name=elsewhere
check "and the collection is still there" 200 "$BASE/demo"
check "collectionadmin cannot reach another collection's settings" 403 -b "$TMP/collectionadmin.jar" \
  "$BASE/newname/settings"

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

# ---- pull requests ----

check "pull request tab" 200 "$BASE/demo/proj"
body_has "pull request tab present" '/demo/proj/pulls"'
check "empty pull request list" 200 "$BASE/demo/proj/pulls"
body_has "empty list invites one" 'No open pull requests'
check "anonymous new pull request redirects to sign in" 302 "$BASE/demo/proj/pulls/new"

check "branches page for a proposal branch" 200 -b "$JAR" "$BASE/demo/proj/branches"
CSRF="$(csrf_of)"
check "create the proposal branch" 302 -b "$JAR" "$BASE/demo/proj/branches/create" \
  --data-urlencode "csrf=$CSRF" --data-urlencode name=proposal --data-urlencode from=main
check "new file form on the proposal branch" 200 -b "$JAR" "$BASE/demo/proj/new/proposal"
CSRF="$(csrf_of)"; EXPECTED="$(expected_of)"
check "commit to the proposal branch" 302 -b "$JAR" "$BASE/demo/proj/new/proposal" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "expected=$EXPECTED" \
  --data-urlencode filename=PROPOSAL.md --data-urlencode "content=A change worth discussing." \
  --data-urlencode "message=Add a proposal"
# A commit on main as well, so the two branches have genuinely diverged and
# the merge is a merge rather than a branch moving forward.
check "new file form on main" 200 -b "$JAR" "$BASE/demo/proj/new/main"
CSRF="$(csrf_of)"; EXPECTED="$(expected_of)"
check "commit to main while the proposal waits" 302 -b "$JAR" "$BASE/demo/proj/new/main" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "expected=$EXPECTED" \
  --data-urlencode filename=MEANWHILE.md --data-urlencode "content=Work continued." \
  --data-urlencode "message=Carry on with main"
check "comparing offers a pull request" 200 "$BASE/demo/proj/compare/main...proposal"
body_has "compare page proposes one" 'Create pull request'

check "new pull request form" 200 -b "$JAR" --get "$BASE/demo/proj/pulls/new" \
  --data-urlencode base=main --data-urlencode head=proposal
CSRF="$(csrf_of)"
check "a pull request needs a title" 400 -b "$JAR" "$BASE/demo/proj/pulls/new" \
  --data-urlencode "csrf=$CSRF" --data-urlencode base=main --data-urlencode head=proposal \
  --data-urlencode "title=   " --data-urlencode "body=x"
check "a branch cannot be proposed into itself" 400 -b "$JAR" "$BASE/demo/proj/pulls/new" \
  --data-urlencode "csrf=$CSRF" --data-urlencode base=main --data-urlencode head=main \
  --data-urlencode "title=Nope" --data-urlencode "body=x"
check "open a pull request" 302 -b "$JAR" "$BASE/demo/proj/pulls/new" \
  --data-urlencode "csrf=$CSRF" --data-urlencode base=main --data-urlencode head=proposal \
  --data-urlencode "title=Propose the change" --data-urlencode "body=Please **look**."
check "pull request page" 200 "$BASE/demo/proj/pulls/1"
body_has "pull request title" 'Propose the change'
body_has "pull request body is rendered markdown" '<strong>look</strong>'
body_has "pull request names its branches" 'wants to merge'
body_has "pull request says it is mergeable" 'no conflicts with main'
body_has "pull request shows the diff" 'PROPOSAL.md'
check "pull request list shows it" 200 "$BASE/demo/proj/pulls"
body_has "list links the pull request" 'href="/demo/proj/pulls/1"'

check "anonymous cannot comment on a pull request" 403 "$BASE/demo/proj/pulls/1/comment" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "body=hello"
check "comment on a pull request" 302 -b "$JAR" "$BASE/demo/proj/pulls/1/comment" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "body=Looks right to me"
check "the comment shows" 200 "$BASE/demo/proj/pulls/1"
body_has "comment body" 'Looks right to me'

check "anonymous cannot merge" 403 "$BASE/demo/proj/pulls/1/merge" --data-urlencode "csrf=$CSRF"
check "csrf is checked on merge" 403 -b "$JAR" "$BASE/demo/proj/pulls/1/merge" --data-urlencode "csrf=bogus"
check "merge the pull request" 302 -b "$JAR" "$BASE/demo/proj/pulls/1/merge" --data-urlencode "csrf=$CSRF"
check "merged pull request page" 200 "$BASE/demo/proj/pulls/1"
body_has "pull request reads as merged" 'Merged'
body_has "merge names who did it" 'merged this'
check "the merge landed on the base branch" 200 "$BASE/demo/proj/commits/main"
body_has "merge commit in the history" 'Merge pull request #1'
check "merging again is refused" 400 -b "$JAR" "$BASE/demo/proj/pulls/1/merge" --data-urlencode "csrf=$CSRF"
check "a merged pull request cannot be reopened" 400 -b "$JAR" "$BASE/demo/proj/pulls/1/state" \
  --data-urlencode "csrf=$CSRF" --data-urlencode state=open
check "pull request for a missing number 404s" 404 "$BASE/demo/proj/pulls/99"

# A second proposal, landed as one commit rather than as a merge, and its
# branch swept away afterwards.
check "branches page for a second proposal" 200 -b "$JAR" "$BASE/demo/proj/branches"
CSRF="$(csrf_of)"
check "create the squash branch" 302 -b "$JAR" "$BASE/demo/proj/branches/create" \
  --data-urlencode "csrf=$CSRF" --data-urlencode name=squashed --data-urlencode from=main
check "new file form on the squash branch" 200 -b "$JAR" "$BASE/demo/proj/new/squashed"
CSRF="$(csrf_of)"; EXPECTED="$(expected_of)"
check "commit to the squash branch" 302 -b "$JAR" "$BASE/demo/proj/new/squashed" \
  --data-urlencode "csrf=$CSRF" --data-urlencode "expected=$EXPECTED" \
  --data-urlencode filename=SQUASHED.md --data-urlencode "content=Landed as one commit." \
  --data-urlencode "message=Work in progress"
check "open the second pull request" 302 -b "$JAR" "$BASE/demo/proj/pulls/new" \
  --data-urlencode "csrf=$CSRF" --data-urlencode base=main --data-urlencode head=squashed \
  --data-urlencode "title=Land this as one commit" --data-urlencode "body=Tidy history, please."
check "the merge box offers both methods" 200 -b "$JAR" "$BASE/demo/proj/pulls/2"
body_has "squash is offered" 'value="squash"'
check "deleting the branch before merging is refused" 400 -b "$JAR" "$BASE/demo/proj/pulls/2/delete-branch" \
  --data-urlencode "csrf=$CSRF"
check "squash and merge" 302 -b "$JAR" "$BASE/demo/proj/pulls/2/merge" \
  --data-urlencode "csrf=$CSRF" --data-urlencode method=squash
check "the squashed commit is on main" 200 "$BASE/demo/proj/commits/main"
body_has "squashed commit names the pull request" 'Land this as one commit (#2)'
check "the squashed branch is still there" 200 "$BASE/demo/proj/branches"
body_has "squash branch present" '>squashed<'
check "delete the merged branch" 302 -b "$JAR" "$BASE/demo/proj/pulls/2/delete-branch" \
  --data-urlencode "csrf=$CSRF"
check "the branch is gone" 200 "$BASE/demo/proj/branches"
body_lacks "squash branch swept away" '>squashed<'


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
check "api collections" 200 -H "Authorization: Bearer $OWNER_TOKEN" "$BASE/api/collections"
body_has "collections carry a repository count" '"name":"demo","repoCount":'
check "api one collection" 200 -H "Authorization: Bearer $OWNER_TOKEN" "$BASE/api/collections/demo"
body_has "and lists its repositories" '"proj"'
check "api unknown collection" 404 -H "Authorization: Bearer $OWNER_TOKEN" "$BASE/api/collections/nosuchcollection"
check "api create collection" 200 -H "Authorization: Bearer $OWNER_TOKEN" \
  -H 'Content-Type: application/json' --data '{"name":"viaapi"}' "$BASE/api/collections"
check "api create collection twice" 409 -H "Authorization: Bearer $OWNER_TOKEN" \
  -H 'Content-Type: application/json' --data '{"name":"viaapi"}' "$BASE/api/collections"
check "api refuses a reserved collection name" 400 -H "Authorization: Bearer $OWNER_TOKEN" \
  -H 'Content-Type: application/json' --data '{"name":"import"}' "$BASE/api/collections"
check "api collection needs a token" 401 -H 'Content-Type: application/json' \
  --data '{"name":"nope"}' "$BASE/api/collections"
check "api collection refuses out of scope" 403 -H "Authorization: Bearer $ALICE_TOKEN" \
  -H 'Content-Type: application/json' --data '{"name":"otherplace"}' "$BASE/api/collections"

# ---- the JSON API over repositories, issues, and pull requests ----

# Everything below sends a bearer token, because that is the only credential the
# API accepts. A repository of its own, pushed in, so these checks own their
# branches and their issue and pull request numbers rather than sharing demo/proj
# with the web checks above.
api() { local d="$1" w="$2"; shift 2; check "$d" "$w" -H "authorization: Bearer $OWNER_TOKEN" "$@"; }
api_as() { local d="$1" w="$2" t="$3"; shift 3; check "$d" "$w" -H "authorization: Bearer $t" "$@"; }
JSON_CT='content-type: application/json'

rm -rf "$TMP/apisrc"
git init -q "$TMP/apisrc"
# Three branches, arranged so that one of them merges and one of them cannot:
# topic touches a file main never touched, while conflicting edits the same line
# of README.md that main went on to edit.
( cd "$TMP/apisrc"
  echo "# Api demo" > README.md
  mkdir -p lib && echo "print('hi')" > lib/a.py
  git add -A && git commit -qm "first commit"
  git checkout -qb conflicting && echo "conflicting line" >> README.md && git commit -qam "conflicting commit"
  git checkout -q main && echo "main line" >> README.md && git commit -qam "main commit"
  git checkout -qb topic && echo "print('b')" > lib/b.py && git add -A && git commit -qm "topic commit"
) > /dev/null 2>&1
git -C "$TMP/apisrc" push -q "http://owner:$OWNER_TOKEN@127.0.0.1:$PORT/apis/repo" main topic conflicting 2>/dev/null
check "the api test repository is there" 200 "$BASE/apis/repo"

# Reads. A token is required for all of them: anonymous reading lives on the web,
# and one rule for the whole API surface is easier to reason about than two.
api "api lists every repository" 200 "$BASE/api/repos"
body_has "including the one just pushed" '"collection":"apis","name":"repo"'
api "api reads one repository" 200 "$BASE/api/repos/apis/repo"
body_has "with its default branch" '"defaultBranch":"main"'
body_has "and what this token may do with it" '"canPush":true'
api "the .git suffix is accepted too" 200 "$BASE/api/repos/apis/repo.git"
api "api branches" 200 "$BASE/api/repos/apis/repo/branches"
body_has "listing the pushed branches" '"name":"topic"'
api "api tags" 200 "$BASE/api/repos/apis/repo/tags"
api "api tree at the root" 200 "$BASE/api/repos/apis/repo/tree"
body_has "with the entries" '"name":"README.md"'
api "api tree with the last commit per entry" 200 "$BASE/api/repos/apis/repo/tree/lib?commits=1"
body_has "which is what costs a git log each" '"lastCommit"'
api "api one file" 200 "$BASE/api/repos/apis/repo/contents/README.md"
body_has "as text" '"encoding":"utf-8"'
body_has "with the commit to hand back as expectedSha" '"commit":"'
api "api raw bytes" 200 -D "$TMP/headers" "$BASE/api/repos/apis/repo/raw/README.md"
header_has "sandboxed, as the web raw route is" 'content-security-policy: sandbox'
api "api commits" 200 "$BASE/api/repos/apis/repo/commits?limit=2"
body_has "newest first" '"subject":"main commit"'
api "api one commit" 200 "$BASE/api/repos/apis/repo/commits/$(git -C "$TMP/apisrc" rev-parse main)"
api "api a commit patch" 200 "$BASE/api/repos/apis/repo/commits/$(git -C "$TMP/apisrc" rev-parse main)/patch"
body_has "as a patch" 'diff --git'
api "api the file list" 200 "$BASE/api/repos/apis/repo/paths"
body_has "with every path in the tree" '"lib/a.py"'
api "api search" 200 "$BASE/api/repos/apis/repo/search?q=Api%20demo"
body_has "finding the line" '"line":1'
api "api compare" 200 "$BASE/api/repos/apis/repo/compare/main...topic"
body_has "with ahead and behind counts" '"ahead":'
api "api languages" 200 "$BASE/api/repos/apis/repo/languages"
api "api contributors" 200 "$BASE/api/repos/apis/repo/contributors"
api "api site says there is none" 200 "$BASE/api/repos/apis/repo/site"
body_has "plainly" '"exists":false'
api "an unknown repository is a 404" 404 "$BASE/api/repos/apis/nosuchrepo"
api "an unknown file is a 404" 404 "$BASE/api/repos/apis/repo/contents/nosuchfile"
api "an unusable ref is a 400" 400 "$BASE/api/repos/apis/repo/tree?ref=..evil"

# The whole authorization story rests on these two, in both directions.
check "the api refuses a request with no token" 401 "$BASE/api/repos/apis/repo"
check "the api refuses a session cookie" 401 -b "$JAR" "$BASE/api/repos/apis/repo/issues"
check "an html post refuses a bearer token" 403 -X POST -H "authorization: Bearer $OWNER_TOKEN" "$BASE/new"

# Writes, and the scope matrix, which is where a mistake in a new transport is
# most likely and least visible. alice has demo/* and nothing else.
api "api opens an issue" 201 -H "$JSON_CT" \
  --data '{"title":"It broke","body":"badly","labels":["bug"]}' "$BASE/api/repos/apis/repo/issues"
body_has "numbered from one" '"number":1'
body_has "and attributed to the token's user" '"author":"owner"'
api "api lists issues" 200 "$BASE/api/repos/apis/repo/issues"
body_has "as a named array rather than a bare one" '{"issues":\['
body_has "carrying a total" '"total":1'
api "api reads one issue with its comments" 200 "$BASE/api/repos/apis/repo/issues/1"
body_has "including the body" '"body":"badly'
api "api comments on an issue" 201 -H "$JSON_CT" \
  --data '{"body":"looking into it"}' "$BASE/api/repos/apis/repo/issues/1/comments"
api "api closes an issue" 200 -H "$JSON_CT" \
  --data '{"state":"closed"}' "$BASE/api/repos/apis/repo/issues/1/state"
body_has "recording who closed it" '"closedBy":"owner"'
api "api edits an issue" 200 -X PATCH -H "$JSON_CT" \
  --data '{"title":"It broke badly","labels":["bug","urgent"]}' "$BASE/api/repos/apis/repo/issues/1"
body_has "with the new title" '"title":"It broke badly"'
api "api reports the labels in use" 200 "$BASE/api/repos/apis/repo/issues/labels"
body_has "with counts" '"label":"urgent","count":1'
api "an unusable label is a 400, not a 500" 400 -H "$JSON_CT" \
  --data '{"title":"x","labels":["!!"]}' "$BASE/api/repos/apis/repo/issues"
api "no author may be supplied in the body" 201 -H "$JSON_CT" \
  --data '{"title":"who wrote this","author":"someone-else"}' "$BASE/api/repos/apis/repo/issues"
body_has "the token's user is the author regardless" '"author":"owner"'

api_as "a token without scope may still read" 200 "$ALICE_TOKEN" "$BASE/api/repos/apis/repo/issues"
api_as "but not write" 403 "$ALICE_TOKEN" -H "$JSON_CT" \
  --data '{"title":"not mine"}' "$BASE/api/repos/apis/repo/issues"
body_has "saying which repository it does not cover" 'push scope does not cover apis/repo'
api_as "and may write where its scope does reach" 201 "$ALICE_TOKEN" -H "$JSON_CT" \
  --data '{"title":"alice was here"}' "$BASE/api/repos/demo/proj/issues"
body_has "as herself" '"author":"alice"'

# Pull requests, including the two routes that are the point of the exercise:
# asking whether a merge would apply, and then making it.
api "api opens a pull request" 201 -H "$JSON_CT" \
  --data '{"title":"Add a thing","body":"please","base":"main","head":"topic"}' "$BASE/api/repos/apis/repo/pulls"
body_has "numbered from one" '"number":1'
api "a pull request between refs that are not branches is refused" 400 -H "$JSON_CT" \
  --data '{"title":"nope","base":"main","head":"nosuchbranch"}' "$BASE/api/repos/apis/repo/pulls"
api "api lists pull requests" 200 "$BASE/api/repos/apis/repo/pulls"
body_has "as a named array" '{"pulls":\['
api "api reads one" 200 "$BASE/api/repos/apis/repo/pulls/1"
api "api gives the commits it proposes" 200 "$BASE/api/repos/apis/repo/pulls/1/commits"
body_has "which is what git says now" '"subject":"topic commit"'
api "api gives the diff" 200 "$BASE/api/repos/apis/repo/pulls/1/diff"
body_has "as a patch" 'diff --git'
api "api answers whether it would merge, without merging" 200 "$BASE/api/repos/apis/repo/pulls/1/merge"
body_has "plainly" '"mergeable":true'
api_as "merging needs push scope, not authorship" 403 "$ALICE_TOKEN" -H "$JSON_CT" \
  --data '{}' "$BASE/api/repos/apis/repo/pulls/1/merge"
api "api merges it" 200 -H "$JSON_CT" \
  --data '{"method":"merge","deleteBranch":true}' "$BASE/api/repos/apis/repo/pulls/1/merge"
body_has "reporting the commit" '"sha":"'
body_has "and that the branch went with it" '"branchDeleted":true'
api "the pull request is merged now" 200 "$BASE/api/repos/apis/repo/pulls/1"
body_has "and says who merged it" '"mergedBy":"owner"'
api "merging it again is a conflict, not a bad request" 409 -H "$JSON_CT" \
  --data '{}' "$BASE/api/repos/apis/repo/pulls/1/merge"
api "the deleted branch is gone" 200 "$BASE/api/repos/apis/repo/branches"
body_lacks "from the branch list" '"name":"topic"'

# A merge that does not apply names the paths, since that is the part a caller
# can act on.
api "a pull request that conflicts" 201 -H "$JSON_CT" \
  --data '{"title":"Conflicting","base":"main","head":"conflicting"}' "$BASE/api/repos/apis/repo/pulls"
api "is reported as unmergeable before anything is written" 200 "$BASE/api/repos/apis/repo/pulls/2/merge"
body_has "with the conflicting paths" '"status":"conflict"'
body_has "naming the file" 'README.md'
api "and merging it is a 409" 409 -H "$JSON_CT" --data '{}' "$BASE/api/repos/apis/repo/pulls/2/merge"
body_has "carrying the conflicts" '"conflicts":\["README.md"\]'
api "closing it instead works" 200 -H "$JSON_CT" \
  --data '{"state":"closed"}' "$BASE/api/repos/apis/repo/pulls/2/state"
body_has "and records who closed it" '"closedBy":"owner"'

# ---- writing a repository over the API ----

api "api creates a repository, with a first commit in it" 201 -H "$JSON_CT" \
  --data '{"collection":"apis","name":"made","description":"Made over the api","initReadme":true}' "$BASE/api/repos"
body_has "reporting the commit it made" '"sha":"'
check "and it is browsable" 200 "$BASE/apis/made"
body_has "with its README rendered" 'Made over the api'
api "creating it again is a conflict" 409 -H "$JSON_CT" \
  --data '{"collection":"apis","name":"made"}' "$BASE/api/repos"
api "a reserved suffix is refused" 400 -H "$JSON_CT" \
  --data '{"collection":"apis","name":"thing.git"}' "$BASE/api/repos"
api_as "creating outside your scope is refused" 403 "$ALICE_TOKEN" -H "$JSON_CT" \
  --data '{"collection":"apis","name":"notmine"}' "$BASE/api/repos"

# PUT creates or updates, so a caller that has read a file and means to change it
# does not have to know which of the two it is doing.
api "api writes a new file" 200 -X PUT -H "$JSON_CT" \
  --data '{"branch":"main","message":"Add a.txt","content":"hello\n"}' "$BASE/api/repos/apis/made/contents/dir/a.txt"
body_has "saying it created it" '"created":true'
api "api writes over it" 200 -X PUT -H "$JSON_CT" \
  --data '{"branch":"main","message":"Change a.txt","content":"goodbye\n"}' "$BASE/api/repos/apis/made/contents/dir/a.txt"
body_lacks "and says it did not create it this time" '"created":true'
api "the change is there to read" 200 "$BASE/api/repos/apis/made/contents/dir/a.txt"
body_has "with the new content" '"content":"goodbye'
API_MADE_SHA="$({ grep -o '"commit":"[0-9a-f]*"' "$BODY" || true; } | head -1 | cut -d'"' -f4)"

# The stale-edit conflict the editor already implements, in the API's own shape.
# A caller that reads, thinks, and writes is exactly the one that needs it.
api "a write against the commit the caller last saw goes through" 200 -X PUT -H "$JSON_CT" \
  --data "{\"branch\":\"main\",\"expectedSha\":\"$API_MADE_SHA\",\"message\":\"guarded\",\"content\":\"guarded\n\"}" \
  "$BASE/api/repos/apis/made/contents/dir/a.txt"
# The same request again: the branch has moved since, which is the whole reason
# for sending the sha at all.
api "and the same write again is a conflict, because the branch moved" 409 -X PUT -H "$JSON_CT" \
  --data "{\"branch\":\"main\",\"expectedSha\":\"$API_MADE_SHA\",\"message\":\"stale\",\"content\":\"stale\n\"}" \
  "$BASE/api/repos/apis/made/contents/dir/a.txt"
api "a sha that names no commit here is a conflict too, not a 500" 409 -X PUT -H "$JSON_CT" \
  --data '{"branch":"main","expectedSha":"0000000000000000000000000000000000000000","message":"stale","content":"x"}' \
  "$BASE/api/repos/apis/made/contents/dir/a.txt"
body_has "saying to read it again" 're-read the file'

api "base64 content is accepted" 200 -X PUT -H "$JSON_CT" \
  --data '{"branch":"main","encoding":"base64","content":"AAECAw==","message":"binary"}' "$BASE/api/repos/apis/made/contents/bin.dat"
api "an unknown encoding is refused" 400 -X PUT -H "$JSON_CT" \
  --data '{"branch":"main","encoding":"rot13","content":"x","message":"no"}' "$BASE/api/repos/apis/made/contents/x.txt"
api "a write can make its own branch" 200 -X PUT -H "$JSON_CT" \
  --data '{"branch":"main","newBranch":"from-api","message":"on a branch","content":"branchy\n"}' "$BASE/api/repos/apis/made/contents/b.txt"
body_has "and says which branch it landed on" '"branch":"from-api"'
api "a branch that already exists is a conflict, not a bad request" 409 -X PUT -H "$JSON_CT" \
  --data '{"branch":"main","newBranch":"from-api","message":"again","content":"y"}' "$BASE/api/repos/apis/made/contents/c.txt"

# Several files as one commit, which is what a caller changing three files as one
# logical edit wants rather than three commits nobody chose.
api "api commits several files at once" 200 -H "$JSON_CT" \
  --data '{"branch":"main","message":"three at once","files":[{"path":"m/1.txt","content":"one"},{"path":"m/2.txt","content":"two"},{"path":"dir/a.txt","delete":true}]}' \
  "$BASE/api/repos/apis/made/commits"
body_has "counting what it wrote" '"files":2'
body_has "and what it removed" '"removed":1'
api "the tree is as the one commit left it" 200 "$BASE/api/repos/apis/made/paths"
body_has "with the files it added" '"m/1.txt"'
body_lacks "and without the one it removed" '"dir/a.txt"'
api "an empty file list is refused" 400 -H "$JSON_CT" \
  --data '{"branch":"main","files":[]}' "$BASE/api/repos/apis/made/commits"

api "api deletes a file" 200 -X DELETE -H "$JSON_CT" \
  --data '{"branch":"main","message":"drop it"}' "$BASE/api/repos/apis/made/contents/m/1.txt"
api "deleting a file that is not there is a 404" 404 -X DELETE -H "$JSON_CT" \
  --data '{"branch":"main"}' "$BASE/api/repos/apis/made/contents/nosuchfile"
api_as "writing without push scope is refused" 403 "$ALICE_TOKEN" -X PUT -H "$JSON_CT" \
  --data '{"branch":"main","content":"x","message":"no"}' "$BASE/api/repos/apis/made/contents/nope.txt"

# A ref name may contain slashes, which is why deletion takes the name as a
# wildcard rather than one path segment.
api "api creates a branch" 201 -H "$JSON_CT" \
  --data '{"name":"release/1.0","from":"main"}' "$BASE/api/repos/apis/made/branches"
api "api deletes a branch whose name has a slash in it" 200 -X DELETE "$BASE/api/repos/apis/made/branches/release/1.0"
body_has "naming what went" '"deleted":"release/1.0"'
api "api creates a tag" 201 -H "$JSON_CT" \
  --data '{"name":"v1.0.0","at":"main"}' "$BASE/api/repos/apis/made/tags"
api "api lists it" 200 "$BASE/api/repos/apis/made/tags"
body_has "among the tags" '"name":"v1.0.0"'
api "api deletes the tag" 200 -X DELETE "$BASE/api/repos/apis/made/tags/v1.0.0"

api "api changes the description and the default branch" 200 -X PATCH -H "$JSON_CT" \
  --data '{"description":"Changed over the api","defaultBranch":"from-api"}' "$BASE/api/repos/apis/made"
body_has "reporting the new default branch" '"defaultBranch":"from-api"'
api "api changes it back" 200 -X PATCH -H "$JSON_CT" --data '{"defaultBranch":"main"}' "$BASE/api/repos/apis/made"
api "changing nothing is a bad request rather than a no-op" 400 -X PATCH -H "$JSON_CT" \
  --data '{}' "$BASE/api/repos/apis/made"

api "api forks a repository" 201 -H "$JSON_CT" \
  --data '{"collection":"apiforks"}' "$BASE/api/repos/apis/made/fork"
body_has "recording where it came from" '"forkedFrom":{"collection":"apis","repo":"made"}'
check "and the fork serves" 200 "$BASE/apiforks/made"
api "api renames it" 200 -H "$JSON_CT" --data '{"name":"renamed"}' "$BASE/api/repos/apiforks/made/rename"
check "at its new address" 200 "$BASE/apiforks/renamed"
no_trace_of "and nothing of it is left under the old name" apiforks made

# The API's equivalent of the web's typed confirmation. It costs nothing and it
# makes an accidental DELETE from a loop over a listing impossible.
api "deleting without a confirmation is refused" 400 -X DELETE "$BASE/api/repos/apiforks/renamed"
body_has "saying what to send" 'confirm=apiforks/renamed'
api "so is the wrong confirmation" 400 -X DELETE "$BASE/api/repos/apiforks/renamed?confirm=apiforks/wrong"
api "with the right one it goes" 200 -X DELETE "$BASE/api/repos/apiforks/renamed?confirm=apiforks/renamed"
check "and it is gone" 404 "$BASE/apiforks/renamed"
no_trace_of "with every sibling directory of it" apiforks renamed

# The divergence most likely to be missed: a commit made over the API is a push
# as far as workflows are concerned, so it plans a run exactly as a git push does.
api "api commits a workflow file" 200 -X PUT -H "$JSON_CT" \
  --data '{"branch":"main","message":"Add a workflow","content":"name: From the api\non: [push]\njobs:\n  one:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n"}' \
  "$BASE/api/repos/apis/made/contents/.github/workflows/api.yml"
API_RUN=""
for _ in $(seq 1 50); do
  if [ -d "$VAULT/collections/apis/repos/made.runs" ] && [ -n "$(ls "$VAULT/collections/apis/repos/made.runs" 2>/dev/null)" ]; then API_RUN=1; break; fi
  sleep 0.2
done
[ -n "$API_RUN" ] || { echo "FAIL: a commit made over the API did not trigger a workflow run"; exit 1; }
PASS=$((PASS+1)); echo "ok: a commit made over the API triggers a workflow run, as a push does"
check "and the run is listed on the web" 200 "$BASE/apis/made/actions"
body_has "under the workflow's name" 'From the api'

# ---- releases, sites, and administration over the API ----

api "api creates a tag to hang a release on" 201 -H "$JSON_CT" \
  --data '{"name":"v0.1.0","at":"main"}' "$BASE/api/repos/apis/repo/tags"
api "a release for a tag that is not there is a 404" 404 -X PUT -H "$JSON_CT" \
  --data '{"name":"nothing"}' "$BASE/api/repos/apis/repo/releases/v9.9.9"
body_has "saying to make the tag first" 'create the tag first'
api "api publishes a release" 201 -X PUT -H "$JSON_CT" \
  --data '{"name":"First cut","body":"It works.","prerelease":true}' "$BASE/api/repos/apis/repo/releases/v0.1.0"
body_has "with its notes" '"body":"It works."'
# PUT rather than POST, so creating and editing are the same call and a caller
# never has to retry an "already exists" as an edit.
api "the same call edits it" 200 -X PUT -H "$JSON_CT" \
  --data '{"body":"It really works."}' "$BASE/api/repos/apis/repo/releases/v0.1.0"
body_has "keeping the title it had" '"name":"First cut"'
body_has "and the author who published it" '"author":"owner"'
api "api lists releases" 200 "$BASE/api/repos/apis/repo/releases"
body_has "as a named array" '{"releases":\['
api_as "publishing needs push scope" 403 "$NARROW_TOKEN" -X PUT -H "$JSON_CT" \
  --data '{"name":"no"}' "$BASE/api/repos/apis/repo/releases/v0.1.0"
api "api deletes the release" 200 -X DELETE "$BASE/api/repos/apis/repo/releases/v0.1.0"
body_has "and says the tag stayed" '"tagKept":true'
api "the tag is still in the repository" 200 "$BASE/api/repos/apis/repo/tags"
body_has "where it was" '"name":"v0.1.0"'

# The site route is read only, deliberately: an upload path here would be a second
# way to write the one directory whose contents are served to browsers.
api "api says a repository with no site has none" 200 "$BASE/api/repos/apis/repo/site"
body_has "plainly" '"exists":false'
mkdir -p "$VAULT/collections/apis/repos/made.site/css"
echo '<h1>made</h1>' > "$VAULT/collections/apis/repos/made.site/index.html"
echo 'body{}' > "$VAULT/collections/apis/repos/made.site/css/site.css"
api "api reports a repository's site" 200 "$BASE/api/repos/apis/made/site"
body_has "saying it has one" '"exists":true'
body_has "and how many files are in it" '"entries":2'

# Tokens are named by an id, never by their hash and never by the token.
api "api reads a user" 200 "$BASE/api/users/narrow"
body_has "with their scope" '"scope":\["nowhere/\*"\]'
body_has "and a token id" '"id":"'
body_lacks "but no hash" '"hash"'
NARROW_TOKEN_ID="$({ grep -o '"id":"[^"]*"' "$BODY" || true; } | head -1 | cut -d'"' -f4)"
api "api lists a user's tokens" 200 "$BASE/api/users/narrow/tokens"
body_lacks "still without a hash" '"hash"'
api_as "a user may read their own record" 200 "$NARROW_TOKEN" "$BASE/api/users/narrow"
api_as "but not somebody else's" 403 "$NARROW_TOKEN" "$BASE/api/users/owner"
api "an unknown user is a 404" 404 "$BASE/api/users/nosuchperson"

api "api revokes one token" 200 -X DELETE "$BASE/api/users/narrow/tokens/$NARROW_TOKEN_ID"
body_has "saying how many are left" '"remaining":0'
check "and the revoked token stops working" 401 -H "authorization: Bearer $NARROW_TOKEN" "$BASE/api/whoami"
api "revoking it again is a 404" 404 -X DELETE "$BASE/api/users/narrow/tokens/$NARROW_TOKEN_ID"
# A user with no tokens is still a user, so mint one back for the checks below.
api "mint a token back for the narrow user" 200 -H "$JSON_CT" \
  --data '{"username":"narrow"}' "$BASE/api/users"
NARROW_TOKEN="$({ grep -o '"token":"cofferdam_[0-9a-f]*"' "$BODY" || true; } | head -1 | cut -d'"' -f4)"
[ -n "$NARROW_TOKEN" ] || { echo "FAIL: no replacement token for the narrow user"; exit 1; }
PASS=$((PASS+1)); echo "ok: a user with no tokens can be given another"

# Removing a user is the one place this adds a capability rather than exposing
# one, so it takes a confirmation and refuses to remove the caller.
api "removing a user without a confirmation is refused" 400 -X DELETE "$BASE/api/users/narrow"
api "removing yourself is refused" 409 -X DELETE "$BASE/api/users/owner?confirm=owner"
body_has "saying who could" 'another admin can'

api "an empty collection to remove" 200 -H "$JSON_CT" \
  --data '{"name":"disposable"}' "$BASE/api/collections"
api "api removes an empty collection" 200 -X DELETE "$BASE/api/collections/disposable"
body_has "naming it" '"deleted":"disposable"'
api "a collection with something in it is refused" 409 -X DELETE "$BASE/api/collections/apis"
body_has "plainly" 'not empty'
api "an unknown collection is a 404" 404 -X DELETE "$BASE/api/collections/nosuchcollection"
api_as "removing a collection needs admin scope over it" 403 "$ALICE_TOKEN" -X DELETE "$BASE/api/collections/viaapi"
api_as "and a collection admin may remove one inside their scope" 409 "$COLLECTION_TOKEN" -X DELETE "$BASE/api/collections/demo"
body_has "getting as far as the emptiness check" 'not empty'

# Renaming a collection over the API, which is the same operation the web offers
# on a collection's settings page.
api "a collection to rename over the api" 201 -H "$JSON_CT" \
  --data '{"collection":"apiold","name":"moving","initReadme":true}' "$BASE/api/repos"
api "api renames a collection" 200 -X POST -H "$JSON_CT" \
  --data '{"name":"apinew"}' "$BASE/api/collections/apiold/rename"
body_has "saying where it came from" '"renamedFrom":"apiold"'
body_has "and how much moved with it" '"repos":1'
api "the collection is at the new name" 200 "$BASE/api/collections/apinew"
body_has "with its repository" '"moving"'
api "and gone from the old one" 404 "$BASE/api/collections/apiold"
api "the repository moved with it" 200 "$BASE/api/repos/apinew/moving"
api "renaming onto an existing collection is refused" 409 -X POST -H "$JSON_CT" \
  --data '{"name":"apis"}' "$BASE/api/collections/apinew/rename"
# nochange is a success with a body saying nothing happened, as everywhere else
# in this API, rather than a 400.
api "renaming to its own name changes nothing" 200 -X POST -H "$JSON_CT" \
  --data '{"name":"apinew"}' "$BASE/api/collections/apinew/rename"
body_has "and says so" '"changed":false'
api "a name that is not usable is refused" 400 -X POST -H "$JSON_CT" \
  --data '{"name":"settings"}' "$BASE/api/collections/apinew/rename"
api "renaming a collection that is not there is a 404" 404 -X POST -H "$JSON_CT" \
  --data '{"name":"whatever"}' "$BASE/api/collections/nosuchcollection/rename"
api_as "renaming a collection needs admin scope over it" 403 "$ALICE_TOKEN" -X POST -H "$JSON_CT" \
  --data '{"name":"alicesnow"}' "$BASE/api/collections/apinew/rename"
api_as "and push scope over where it lands" 403 "$COLLECTION_TOKEN" -X POST -H "$JSON_CT" \
  --data '{"name":"elsewhere"}' "$BASE/api/collections/demo/rename"
body_has "naming what is out of reach" 'push scope'


api "api reads the vault settings" 200 "$BASE/api/config"
body_has "with the theme" '"theme":'
body_has "and the themes to choose from" '"themes":\['
body_has "and the limits, which are read only here" '"requestsPerMinute":'
api "api changes the theme and the retention" 200 -X PATCH -H "$JSON_CT" \
  --data '{"theme":"slate","ci":{"runs":7,"days":3,"artifactMb":100}}' "$BASE/api/config"
body_has "reporting what it saved" '"runs":7'
api "an unknown theme is refused, naming the real ones" 400 -X PATCH -H "$JSON_CT" \
  --data '{"theme":"chartreuse"}' "$BASE/api/config"
body_has "by listing them" 'paper'
api "changing nothing is refused" 400 -X PATCH -H "$JSON_CT" --data '{}' "$BASE/api/config"
# Not merely an admin: a delegated collection administrator should not restyle
# the whole vault, which is the rule the web applies to the same setting.
api_as "vault settings need admin over everything" 403 "$COLLECTION_TOKEN" "$BASE/api/config"
body_has "saying as much" 'whole vault'
api "put the theme back" 200 -X PATCH -H "$JSON_CT" --data '{"theme":"paper"}' "$BASE/api/config"

# The hostname sites are served from is the setting a hosted vault most needs to
# change, and every reader of it calls loadConfig per request, so it is writable
# here: reaching a volume to edit config.json by hand is the worst step in that
# whole path.
api "api sets the hostname sites are served from" 200 -X PATCH -H "$JSON_CT" \
  --data '{"sites":{"host":"Sites.Example.Org."}}' "$BASE/api/config"
body_has "normalizing it the way a hostname is normalized" '"host":"sites.example.org"'
check "in effect on the next request, with no restart" 404 "$BASE/" -H 'Host: nosuchrepo--demo.sites.example.org'
# loadConfig ignores an unusable value and serves the default, which is right for
# a hand-edited file and wrong for a caller who just asked for a change.
api "a value that is not a hostname is refused rather than quietly ignored" 400 -X PATCH -H "$JSON_CT" \
  --data '{"sites":{"host":"https://nope:3000/x"}}' "$BASE/api/config"
body_has "saying what was wrong with it" 'not a hostname'
api "and the refusal stored nothing" 200 "$BASE/api/config"
body_has "leaving the working hostname in place" '"host":"sites.example.org"'
api "an empty host serves sites on the forge hostname again" 200 -X PATCH -H "$JSON_CT" \
  --data '{"sites":{"host":""}}' "$BASE/api/config"
body_has "reporting the cleared value" '"host":""'
check "which also takes effect on the next request" 200 "$BASE/" -H 'Host: nosuchrepo--demo.sites.example.org'

# ---- cofferdam login: the token in git's credential store ----

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
# The global config goes with the isolated HOME, so that what `cofferdam login`
# writes lands there and starts out empty: the first check needs no helper to
# be configured anywhere git will look.
# XDG_CONFIG_HOME goes with it, so the vault that `cofferdam login` records
# lands here too rather than in the developer's own configuration.
cred_env() { env HOME="$CRED_HOME" XDG_CONFIG_HOME="$CRED_HOME/.config" GIT_CONFIG_GLOBAL="$CRED_HOME/.gitconfig" GIT_ASKPASS="$TMP/askpass" SSH_ASKPASS="$TMP/askpass" "$@"; }
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
run_code() {
  local desc="$1" want="$2"; shift 2
  local got=0
  "$@" > "$BODY" 2>"$BODY.err" || got=$?
  if [ "$got" != "$want" ]; then
    echo "FAIL: $desc (want exit $want, got $got)"; head -c 2000 "$BODY" "$BODY.err"; echo; exit 1
  fi
  PASS=$((PASS+1)); echo "ok: $desc"
}
# Parseable JSON and nothing else on stdout: the contract a caller piping into
# a parser depends on. node is already required to run the server, so it is the
# parser here; the suite has no jq.
stdout_is_json() {
  local desc="$1"
  if ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$BODY" 2>/dev/null; then
    echo "FAIL: $desc (stdout was not one JSON value)"; head -c 2000 "$BODY"; echo; exit 1
  fi
  PASS=$((PASS+1)); echo "ok: $desc"
}
err_has() {
  local desc="$1" pattern="$2"
  grep -q -e "$pattern" "$BODY.err" || { echo "FAIL: $desc (not on stderr: $pattern)"; head -c 2000 "$BODY.err"; echo; exit 1; }
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
body_has "login names the helpers it could use" 'cofferdam login --helper store'

run_fails "login refuses a bad token before storing it" \
  cli login --host "$BASE" --token cofferdam_not_a_real_token --helper store
if [ -e "$CRED_HOME/.git-credentials" ]; then echo "FAIL: a rejected token was stored anyway"; exit 1; fi
PASS=$((PASS+1)); echo "ok: nothing stored for a rejected token"

run_ok "login stores the token" cli login --host "$BASE" --token "$OWNER_TOKEN" --helper store
grep -q "$OWNER_TOKEN" "$CRED_HOME/.git-credentials" || { echo "FAIL: token not in the credential store"; exit 1; }
PASS=$((PASS+1)); echo "ok: token is in the credential store"
if [ "$TMP_PRIVATE" = 1 ]; then
  CRED_MODE="$(stat -c '%a' "$CRED_HOME/.git-credentials" 2>/dev/null || stat -f '%Lp' "$CRED_HOME/.git-credentials")"
  [ "$CRED_MODE" = 600 ] || { echo "FAIL: credential file is mode $CRED_MODE, not 0600"; exit 1; }
  PASS=$((PASS+1)); echo "ok: credential file is mode 0600"
else
  echo "skip: this filesystem forces file modes, so 0600 on the credential file cannot be checked here"
fi
# The vault is recorded as well, which is the whole of the CLI's configuration:
# commands after a login take no arguments and read no environment.
LOGIN_JSON="$CRED_HOME/.config/cofferdam/login.json"
grep -q "\"$BASE\"" "$LOGIN_JSON" || { echo "FAIL: login did not record the vault URL"; exit 1; }
PASS=$((PASS+1)); echo "ok: login recorded the vault URL"
run_ok "whoami needs no arguments after login" cli whoami
body_has "whoami names the logged-in user and vault" "owner @ $BASE"
run_ok "user list needs no arguments after login" cli user list
body_has "user list came from the vault" 'push: *'
run_ok "runner list needs no arguments after login" cli runner list

# ---- the command registry, `cofferdam api`, and the output contract ----

# Help is per command rather than one dump of all of them, which is what keeps
# it small enough for a caller with a context window to read.
run_ok "top-level help lists groups, not every command" cli --help
body_has "help names a group" 'Command groups:'
body_lacks "and does not inline a group's commands" 'user grant'
run_ok "group help lists that group" cli user --help
body_has "with its commands" 'grant .*Extend an existing'
run_ok "command help lists that command's options" cli user add --help
body_has "with an option summary" -- '--token-scope'

run_code "an unknown command is a usage error" 2 cli nosuchcommand
err_has "and says so" "unknown command 'nosuchcommand'"
run_code "a misspelled subcommand is suggested" 2 cli user lst
err_has "by name" "did you mean 'user list'"
run_code "an unknown option is a usage error" 2 cli whoami --jsn
err_has "with the nearest real option" 'did you mean --json'

run_ok "commands --json dumps the registry" cli commands --json
stdout_is_json "the registry is one JSON value on stdout"
body_has "and names a command path" '"whoami"'

# --json goes to stdout and nothing else does, which is the whole point.
run_ok "whoami --json" cli whoami --json
stdout_is_json "whoami --json is parseable"
body_has "with the fields the API returned" '"username": "owner"'
run_ok "a field list keeps only those fields" cli whoami --json=username,scope
body_lacks "dropping the rest" 'tokenScope'

# The generic escape hatch: one read and one write, with the path written the
# short way to prove the prefix is optional.
run_ok "api reads a route" cli api whoami
stdout_is_json "and prints its JSON verbatim"
body_has "which is the whoami body" '"username":"owner"'
run_ok "api takes a full path too" cli api /api/collections
run_ok "api writes with --field" cli api collections -X POST --field name=fromapi
body_has "and the vault created it" '"created":true'
check "the collection the api command made is there" 200 "$BASE/fromapi"

# The exit codes an agent retries on. 4 and 5 are the two that earn their keep.
run_code "a 404 from the vault exits 4" 4 cli api collections/nosuchcollection
run_code "a 409 from the vault exits 5" 5 cli api collections -X POST --field name=fromapi
run_code "a rejected token exits 3" 3 cli whoami --token cofferdam_not_a_real_token
run_code "and reports the refusal as JSON when asked" 3 cli whoami --json --token cofferdam_not_a_real_token
err_has "on stderr, as an error object" '{"error":'
if [ -s "$BODY" ]; then echo "FAIL: a failed --json command wrote to stdout"; exit 1; fi
PASS=$((PASS+1)); echo "ok: nothing on stdout when a --json command fails"

# A token on stdin, so it is in neither argv nor shell history.
run_ok "--token-stdin reads the token from stdin" sh -c "echo '$OWNER_TOKEN' | $(printf '%s ' env HOME="$CRED_HOME" XDG_CONFIG_HOME="$CRED_HOME/.config" GIT_CONFIG_GLOBAL="$CRED_HOME/.gitconfig" GIT_ASKPASS="$TMP/askpass") node dist/index.js whoami --host '$BASE' --token-stdin"
body_has "and it worked" "owner @ $BASE"
# The two ways of getting --token-stdin wrong exit differently on purpose, and
# the difference is the documented one: naming the token twice is a malformed
# invocation, while a pipe that came up empty is a missing token.
run_code "--token and --token-stdin together is a usage error" 2 \
  sh -c "node dist/index.js whoami --host '$BASE' --token x --token-stdin < /dev/null"
run_code "--token-stdin with nothing on stdin is an auth error" 3 \
  sh -c "echo '' | node dist/index.js whoami --host '$BASE' --token-stdin"

# ---- the repository, issue, and pull request commands ----

# The API above is checked route by route; these check the layer over it: that a
# command reaches the right route, prints a table by default, and prints one JSON
# value on stdout when asked.
run_ok "repo list" cli repo list
body_has "naming a repository" 'apis/repo'
run_ok "repo view" cli repo view apis/repo
body_has "with its default branch" 'default branch *main'
run_ok "repo view --json with a field list" cli repo view apis/repo --json=name,defaultBranch
stdout_is_json "which is one JSON value"
body_lacks "and only those fields" 'openIssues'
run_ok "branch list" cli branch list --repo apis/repo
body_has "marking the default branch" '\* main'
run_ok "file list" cli file list --repo apis/repo
body_has "with the entries" 'README.md'
run_ok "file list --all" cli file list --all --repo apis/repo
body_has "listing paths in the tree" 'lib/a.py'
run_ok "file view" cli file view README.md --repo apis/repo
body_has "printing the file" '# Api demo'
run_ok "commit list" cli commit list --repo apis/repo --limit 2
run_ok "search" cli search 'Api demo' --repo apis/repo
body_has "as path:line: text" 'README.md:1:'
run_ok "diff --stat" cli diff main...conflicting --repo apis/repo --stat
body_has "with the counts" 'ahead'

run_ok "issue create" cli issue create --repo apis/repo --title "From the cli" --body "a body"
body_has "printing the issue url" "$BASE/apis/repo/issues/"
run_ok "issue list" cli issue list --repo apis/repo
body_has "including the new one" 'From the cli'
run_ok "issue list --json" cli issue list --repo apis/repo --json=number,title
stdout_is_json "as one JSON value"
run_ok "issue comment with a body file" sh -c "printf 'from a file\n' > '$TMP/body.md'; $(printf '%s ' env HOME="$CRED_HOME" XDG_CONFIG_HOME="$CRED_HOME/.config" GIT_CONFIG_GLOBAL="$CRED_HOME/.gitconfig" GIT_ASKPASS="$TMP/askpass") node dist/index.js issue comment 3 --repo apis/repo --body-file '$TMP/body.md'"
run_ok "issue view --comments" cli issue view 3 --repo apis/repo --comments
body_has "showing the comment" 'from a file'
run_ok "issue close" cli issue close 3 --repo apis/repo
body_has "reporting the new state" 'closed'
run_code "--body and --body-file together is a usage error" 2 \
  cli issue comment 3 --repo apis/repo --body x --body-file "$TMP/body.md"

run_ok "pr list" cli pr list --repo apis/repo --state all
body_has "including the merged one" 'Add a thing'
run_ok "pr view" cli pr view 1 --repo apis/repo
body_has "saying it was merged" 'merged'
run_code "pr merge on a closed pull request exits 5" 5 cli pr merge 2 --repo apis/repo

# Writing, from the command line. --yes rather than a prompt on everything
# destructive: a prompt is no use to a caller that is not a person, and a command
# that prompts is a command that hangs in a container.
run_ok "repo create" cli repo create clirepos/made --description "Made from the cli" --readme
body_has "printing its url" "$BASE/clirepos/made"
run_ok "file write from stdin" \
  sh -c "printf 'written from the cli\n' | $(printf '%s ' env HOME="$CRED_HOME" XDG_CONFIG_HOME="$CRED_HOME/.config" GIT_CONFIG_GLOBAL="$CRED_HOME/.gitconfig" GIT_ASKPASS="$TMP/askpass") node dist/index.js file write notes.md --repo clirepos/made --message 'Add notes'"
body_has "saying what it did" 'Created notes.md on main'
run_ok "file view reads it back" cli file view notes.md --repo clirepos/made
body_has "with the content" 'written from the cli'
run_ok "the commit to hand back is available" cli file view notes.md --repo clirepos/made --json=commit
CLI_SHA="$({ grep -o '"commit": "[0-9a-f]*"' "$BODY" || true; } | head -1 | cut -d'"' -f4)"
run_ok "a guarded write goes through" \
  cli file write notes.md --repo clirepos/made --body "second" --expected-sha "$CLI_SHA" --message "Second"
run_code "and the same one again exits 5" 5 \
  cli file write notes.md --repo clirepos/made --body "third" --expected-sha "$CLI_SHA" --message "Third"

run_ok "branch create" cli branch create topic --repo clirepos/made
run_ok "branch list shows it" cli branch list --repo clirepos/made
body_has "among the branches" 'topic'
run_code "branch delete refuses without --yes" 2 cli branch delete topic --repo clirepos/made
err_has "and says what to pass" -- '--yes'
run_ok "branch delete with --yes" cli branch delete topic --repo clirepos/made --yes
run_ok "tag create" cli tag create v0.1.0 --repo clirepos/made
run_ok "tag list shows it" cli tag list --repo clirepos/made
body_has "among the tags" 'v0.1.0'
run_ok "tag delete with --yes" cli tag delete v0.1.0 --repo clirepos/made --yes
run_code "file delete refuses without --yes" 2 cli file delete notes.md --repo clirepos/made
run_ok "file delete with --yes" cli file delete notes.md --repo clirepos/made --yes

run_ok "repo edit" cli repo edit clirepos/made --description "Edited from the cli"
run_ok "repo view shows the change" cli repo view clirepos/made
body_has "with the new description" 'Edited from the cli'
run_ok "repo clone fills in the vault url" \
  sh -c "rm -rf '$TMP/cliclone' && cd '$TMP' && $(printf '%s ' env HOME="$CRED_HOME" XDG_CONFIG_HOME="$CRED_HOME/.config" GIT_CONFIG_GLOBAL="$CRED_HOME/.gitconfig" GIT_ASKPASS="$TMP/askpass") node '$PWD/dist/index.js' repo clone clirepos/made cliclone"
[ -d "$TMP/cliclone/.git" ] || { echo "FAIL: repo clone produced no clone"; exit 1; }
PASS=$((PASS+1)); echo "ok: the clone is there"
run_code "repo delete refuses without --yes" 2 cli repo delete clirepos/made
run_ok "repo delete with --yes" cli repo delete clirepos/made --yes
check "and the repository is gone" 404 "$BASE/clirepos/made"

# ---- releases, users, and settings from the command line ----

run_ok "release create on an existing tag" \
  cli release create v0.1.0 --repo apis/repo --title "From the cli" --notes "Notes." --prerelease
run_ok "release list" cli release list --repo apis/repo
body_has "with the tag" 'v0.1.0'
body_has "marked a prerelease" 'prerelease'
run_ok "release view" cli release view v0.1.0 --repo apis/repo
body_has "showing the notes" 'Notes.'
run_ok "release edit --latest clears the prerelease flag" cli release edit v0.1.0 --repo apis/repo --latest
run_ok "and it is no longer one" cli release view v0.1.0 --repo apis/repo --json=prerelease
body_has "plainly" '"prerelease": false'
run_code "release delete refuses without --yes" 2 cli release delete v0.1.0 --repo apis/repo
run_ok "release delete with --yes" cli release delete v0.1.0 --repo apis/repo --yes
body_has "saying the tag stayed" 'tag itself is still there'

# A user of its own to revoke and remove, so that the checks further down still
# have the narrow user they expect.
run_ok "user add, to have one to remove" cli user add spare --scope 'nowhere/*'
run_ok "user view" cli user view spare
body_has "with their scope" 'push: nowhere/\*'
run_ok "user token list" cli user token list spare
CLI_TOKEN_ID="$(head -1 "$BODY" | awk '{print $1}')"
[ -n "$CLI_TOKEN_ID" ] || { echo "FAIL: no token id listed"; exit 1; }
PASS=$((PASS+1)); echo "ok: a token is named by an id rather than by its hash"
run_code "user token revoke refuses without --yes" 2 cli user token revoke spare "$CLI_TOKEN_ID"
run_ok "user token revoke with --yes" cli user token revoke spare "$CLI_TOKEN_ID" --yes
body_has "counting what is left" 'token'
run_code "user delete refuses without --yes" 2 cli user delete spare
run_ok "user delete with --yes" cli user delete spare --yes
run_code "and the user is gone" 4 cli user view spare

run_ok "collection add, to have one to rename and remove" cli collection add throwaway
run_ok "collection rename" cli collection rename throwaway keptaway
body_has "reporting the new name and what moved" 'Now keptaway, with 0 repositories'
check "the collection is at the new name" 200 "$BASE/keptaway"
check "and gone from the old one" 404 "$BASE/throwaway"
run_ok "collection rename to its own name reports no change" cli collection rename keptaway keptaway
body_has "rather than a rename that did not happen" 'already its name'
run_code "collection rename onto an existing one is a conflict" 5 cli collection rename keptaway demo
run_code "collection rename of one that is not there is a 404" 4 cli collection rename nosuchone x
run_ok "collection rename --json" cli collection rename keptaway throwaway --json
body_has "with the fields a program reads" '"renamedFrom": "keptaway"'
run_code "collection delete refuses without --yes" 2 cli collection delete throwaway
run_ok "collection delete with --yes" cli collection delete throwaway --yes
check "and the collection is gone" 404 "$BASE/throwaway"

run_ok "config view" cli config view
body_has "naming the theme" 'theme'
body_has "and saying which settings a write cannot reach" 'read once at startup'
run_ok "config set" cli config set --ci-runs 11
body_has "reporting what it kept" 'keep 11 runs'
run_ok "config set gives sites a hostname of their own" cli config set --sites-host sites.example.org
body_has "naming the origin each site gets" 'sites.example.org'
body_has "and saying that no restart is needed" 'In effect now'
run_code "a sites host that is not a hostname is refused" 1 cli config set --sites-host 'not a host'
run_ok "and an empty one puts sites back on the forge host" cli config set --sites-host ''
body_has "saying which of the two arrangements is in force" 'sandboxed'
run_code "and a conflict is reported with its paths" 5 cli pr merge 2 --repo apis/repo
err_has "naming the file that conflicts" 'This pull request is not open'

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

# A caller standing in a clone should not have to say where it is. The remote has
# to point at this vault: a clone of somewhere else must not be read as naming a
# repository here.
run_ok "the repository comes from the git remote here" \
  sh -c "cd '$TMP/credclone' && $(printf '%s ' env HOME="$CRED_HOME" XDG_CONFIG_HOME="$CRED_HOME/.config" GIT_CONFIG_GLOBAL="$CRED_HOME/.gitconfig" GIT_ASKPASS="$TMP/askpass") node '$PWD/dist/index.js' repo view --json=collection,name"
body_has "which is the repository it was cloned from" '"name": "proj"'
run_ok "a remote for somewhere else is not an answer" \
  sh -c "cd '$TMP/credclone' && git remote set-url origin https://github.com/owner/other.git && $(printf '%s ' env HOME="$CRED_HOME" XDG_CONFIG_HOME="$CRED_HOME/.config" GIT_CONFIG_GLOBAL="$CRED_HOME/.gitconfig" GIT_ASKPASS="$TMP/askpass") node '$PWD/dist/index.js' repo view --repo apis/repo --json=name; git -C '$TMP/credclone' remote set-url origin '$BASE/demo/proj'"
# The restore has to happen whatever the command did, and the command's own exit
# code is what is being asserted, so it is captured rather than shadowed.
run_code "and with no remote for this vault it is a usage error" 2 \
  sh -c "cd '$TMP/credclone' && git remote set-url origin https://github.com/owner/other.git && { $(printf '%s ' env HOME="$CRED_HOME" XDG_CONFIG_HOME="$CRED_HOME/.config" GIT_CONFIG_GLOBAL="$CRED_HOME/.gitconfig" GIT_ASKPASS="$TMP/askpass") node '$PWD/dist/index.js' repo view; code=\$?; git remote set-url origin '$BASE/demo/proj'; exit \$code; }"
err_has "naming all three ways to say" 'COFFERDAM_REPO'

# ---- cofferdam import and collections, from the CLI ----

# Importing is a client-side operation and `cofferdam import` is
# what performs it: a bare clone into a temporary directory, a mirror push at
# the vault, and the clone removed again. The source here is a directory on this
# machine, which import accepts alongside a URL and which is also what a suite
# with no network can offer.
rm -rf "$TMP/importsrc"
git init -q "$TMP/importsrc"
echo "imported by the cli" > "$TMP/importsrc/README.md"
git -C "$TMP/importsrc" add README.md
git -C "$TMP/importsrc" commit -qm "source commit"

run_ok "collection add creates a collection with nothing in it" cli collection add fromcli
check "the created collection has a page" 200 "$BASE/fromcli"
body_has "and it is empty" 'No repositories in this collection yet'
run_fails "collection add refuses a name already taken" cli collection add fromcli
run_ok "import a local repository" cli import "$TMP/importsrc" fromcli
no_prompt "import asked for no credential"
check "the imported repository is browsable" 200 "$BASE/fromcli/importsrc/blob/main/README.md"
body_has "with the source's content" 'imported by the cli'
run_ok "collection list reports it" cli collection list
body_has "with a repository count" 'fromcli.*1 repository'
run_fails "importing over an existing repository is refused" cli import "$TMP/importsrc" fromcli
body_has "and says how to import under another name" 'another-name'
run_ok "import names the repository when asked to" cli import "$TMP/importsrc" fromcli/renamed
check "the renamed import is there" 200 "$BASE/fromcli/renamed"
run_ok "import creates the collection by pushing to it" cli import "$TMP/importsrc" madebyimport
check "the collection the push created is there" 200 "$BASE/madebyimport/importsrc"
run_fails "import refuses a source it cannot clone" cli import 'not a url' fromcli
run_fails "import refuses to guess a collection" cli import "$TMP/importsrc"
body_has "and asks which one" 'Which collection'
# The clone is scratch and temporary in both senses: it is removed whether the
# import succeeded or failed, which a process.exit inside the import would skip.
LEFTOVER="$(ls -d "${TMPDIR:-/tmp}"/cofferdam-import-* 2>/dev/null || true)"
[ -z "$LEFTOVER" ] || { echo "FAIL: import left a clone behind: $LEFTOVER"; exit 1; }
PASS=$((PASS+1)); echo "ok: no temporary clone left behind"

# logout with no arguments, since the vault it removes is the one login recorded.
run_ok "logout removes it" cli logout
if [ -s "$CRED_HOME/.git-credentials" ]; then echo "FAIL: credential still stored after logout"; exit 1; fi
PASS=$((PASS+1)); echo "ok: credential file is empty after logout"
if [ -e "$LOGIN_JSON" ]; then echo "FAIL: logout left the vault recorded"; exit 1; fi
PASS=$((PASS+1)); echo "ok: logout forgot the vault too"
run_fails "commands stop working after logout" cli whoami
body_has "and say to log in" 'cofferdam login'
# A container has no keyring and may have no writable home, so the environment
# is a source of both, between the flags and the login.
run_ok "COFFERDAM_HOST and COFFERDAM_TOKEN stand in for a login" \
  cred_env env COFFERDAM_HOST="$BASE" COFFERDAM_TOKEN="$OWNER_TOKEN" node dist/index.js whoami
body_has "as the same user" "owner @ $BASE"
run_ok "and --token still wins over the environment" \
  cred_env env COFFERDAM_HOST="$BASE" COFFERDAM_TOKEN=cofferdam_wrong node dist/index.js whoami --token "$OWNER_TOKEN"
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

# Push-to-create must not hand out a name that would land on another
# repository's sibling directory: a repository called `created.issues` occupies
# exactly the path `created`'s issues live at.
cd "$TMP/clone"
if git push -q "http://owner:$OWNER_TOKEN@127.0.0.1:$PORT/pushed/created.issues" main 2>"$TMP/pusherr"; then
  echo "FAIL: push-to-create accepted a reserved repository name"; exit 1
fi
cd - >/dev/null
grep -qi 'reserved' "$TMP/pusherr" || { echo "FAIL: the refusal did not say the name is reserved"; cat "$TMP/pusherr"; exit 1; }
[ ! -e "$VAULT/collections/pushed/repos/created.issues" ] || { echo "FAIL: the refused push created the directory anyway"; exit 1; }
PASS=$((PASS+2)); echo "ok: push-to-create refuses a name reserved for a sibling directory"

# ---- site ----

SITE="$VAULT/collections/pushed/repos/created.site"
mkdir -p "$SITE/sub"
echo '<h1>site ok</h1>' > "$SITE/index.html"
echo '<h1>sub index</h1>' > "$SITE/sub/index.html"
echo 'a real file' > "$SITE/sub/real.txt"
echo '<h1>site not found</h1>' > "$SITE/404.html"
check "site served" 200 "$BASE/pushed/created/site/"
body_has "site content" 'site ok'
# The collection listing points at the site directly, so a visitor scanning a
# collection reaches the published page without going through the repository.
check "the collection listing is served" 200 "$BASE/pushed"
body_has "with a link to the site" 'class="site-link" href="/pushed/created/site/"'
check "a collection whose repositories have no site" 200 "$BASE/demo"
body_lacks "carries no site link" 'class="site-link"'
check "a directory redirects to its slash" 302 "$BASE/pushed/created/site/sub"
check "a directory serves its index" 200 "$BASE/pushed/created/site/sub/"
body_has "the subdirectory index is served" 'sub index'
check "an ordinary file is served" 200 "$BASE/pushed/created/site/sub/real.txt"
check "a missing path gets the site's own 404" 404 "$BASE/pushed/created/site/nope.html"
body_has "the site's 404 page is used" 'site not found'

# A site is published by whatever can write the directory, a workflow included,
# and a tar unpacked into it can carry symlinks. What is served is therefore
# what is really inside the directory: a link resolving out of it reads as a
# missing file, and says no more than that, so a prober cannot tell a refused
# path from an absent one. A link within the site keeps working.
ln -s /etc/passwd "$SITE/escape.txt"
ln -s ../../vault.json "$SITE/vault.json"
ln -s /etc "$SITE/etcdir"
ln -s index.html "$SITE/inner.html"
check "a symlink out of the site is not served" 404 "$BASE/pushed/created/site/escape.txt"
body_lacks "and none of its content leaks" 'root:'
body_has "it reads as a missing file" 'site not found'
check "a symlink up into the vault is not served" 404 "$BASE/pushed/created/site/vault.json"
body_lacks "and the vault's users do not leak" 'tokens'
# Not a redirect: answering 302 here would tell a prober the directory is there.
check "a symlinked directory out of the site is not served" 404 "$BASE/pushed/created/site/etcdir"
check "a symlink within the site still works" 200 "$BASE/pushed/created/site/inner.html"
body_has "the in-site link serves its target" 'site ok'

# Site files are the only bytes in the vault that someone other than the server
# supplies and that come back as HTML. On the forge's own origin that would let
# a site's script read the visitor's session, scrape the CSRF token out of any
# page it can fetch, and act as them, which is a privilege escalation from push
# scope on one repository to whatever the visitor can do. The sandbox puts the
# document in an opaque origin instead.
check "site response for the header checks" 200 -D "$TMP/headers" "$BASE/pushed/created/site/"
header_has "the site response is sandboxed" 'content-security-policy: sandbox'
header_lacks "without allow-same-origin, which is what makes the origin opaque" 'allow-same-origin'
header_lacks "and without anything unsafe" 'unsafe'
# Load-bearing: a page in an opaque origin cannot fetch its own sibling files
# without it, and those fetches still carry no credentials.
header_has "cross-origin reads of the site's own files are allowed" 'access-control-allow-origin: \*'
header_has "and the type is not sniffed" 'x-content-type-options: nosniff'
header_lacks "no session cookie is set on a site response" 'set-cookie'
check "the site's own 404 response" 404 -D "$TMP/headers" "$BASE/pushed/created/site/nope.html"
header_has "carries the sandbox too" 'content-security-policy: sandbox'
header_has "and the cross-origin header" 'access-control-allow-origin: \*'
# Only site responses. A forge page that allowed cross-origin reads would hand
# any other site the contents of whatever the visitor can see.
check "a forge page for comparison" 200 -D "$TMP/headers" -b "$JAR" "$BASE/pushed/created"
header_lacks "forge pages allow no cross-origin reads" 'access-control-allow-origin'
header_lacks "and are not sandboxed" 'content-security-policy'

# ---- sites on their own hostname ----

# A sandbox costs a site its cookies, storage, and service workers. Giving each
# repository's site a hostname of its own gives them back, because the browser's
# own origin separation is then doing the work. config.json is re-read per
# request, so this needs no restart, which is also the point: removing
# sites.host must take effect on the next request rather than at the next start.
printf '{\n  "theme": "paper",\n  "sites": { "host": "sites.localhost" }\n}\n' > "$VAULT/config.json"
SITE_HOST='created--pushed.sites.localhost'

# On the forge host the path only points at the site origin now. 302 and not
# 301, so that removing the setting is not defeated by a cached redirect.
check "the forge site path redirects" 302 -D "$TMP/headers" "$BASE/pushed/created/site/"
header_has "to the site's own origin" "location: http://$SITE_HOST/"
check "and does so from the missing-slash path in one hop" 302 -D "$TMP/headers" "$BASE/pushed/created/site"
header_has "landing on the origin root" "location: http://$SITE_HOST/"
check "a path with a query string redirects too" 302 -D "$TMP/headers" "$BASE/pushed/created/site/sub/real.txt?x=1"
header_has "keeping the query" "location: http://$SITE_HOST/sub/real.txt?x=1"

check "the collection listing follows the site to its own origin" 200 "$BASE/pushed"
body_has "linking there rather than through the forge path" "class=\"site-link\" href=\"http://$SITE_HOST/\""

check "the site serves on its own hostname" 200 -D "$TMP/headers" -H "Host: $SITE_HOST" "$BASE/"
body_has "with its own index" 'site ok'
header_has "the type is still not sniffed" 'x-content-type-options: nosniff'
header_lacks "and it is not sandboxed there, which is the point of the hostname" 'content-security-policy'
# The site handler runs before the forge's own asset routes, or /assets/style.css
# on a site's hostname would give it the forge's stylesheet rather than its own.
check "the forge stylesheet does not shadow the site's" 404 -H "Host: $SITE_HOST" "$BASE/assets/style.css"
check "nor does the forge favicon" 404 -H "Host: $SITE_HOST" "$BASE/favicon.svg"
check "an ordinary file on the site host" 200 -H "Host: $SITE_HOST" "$BASE/sub/real.txt"
check "a directory redirects to its slash on the site host" 302 -D "$TMP/headers" -H "Host: $SITE_HOST" "$BASE/sub"
header_has "relative to the site origin" 'location: /sub/'
# The containment checks are the same code, so this is a regression test for the
# extraction rather than for anything new.
check "a symlink out of the site is refused on the site host too" 404 -H "Host: $SITE_HOST" "$BASE/escape.txt"
body_lacks "and still leaks nothing" 'root:'

# No session is resolved on a sites hostname and none is minted there, which is
# what keeps the forge's authority on the forge's hostname.
check "a session cookie on the site host is ignored" 200 -D "$TMP/headers" -b "$JAR" -H "Host: $SITE_HOST" "$BASE/"
body_lacks "no signed-in chrome" '>owner<'
header_lacks "and no cookie is set" 'set-cookie'

# Every other name under the sites host answers for itself rather than falling
# through, so the forge is reachable only on the forge's hostname.
check "the bare sites host names no site" 404 "$BASE/" -H 'Host: sites.localhost'
body_lacks "and does not render forge chrome" 'assets/style.css'
check "a deeper name under the sites host names no site" 404 "$BASE/" -H 'Host: a.b.sites.localhost'
check "a hostname naming no repository is a 404" 404 "$BASE/" -H "Host: nosuchrepo--pushed.sites.localhost"
# Sites are files, so nothing on this hostname needs a method that writes.
check "a write method on a site host is refused" 405 -X POST -H "Host: $SITE_HOST" "$BASE/"

# A name that is not a legal hostname label is refused rather than mangled:
# lowercasing My.Repo would collide with a my-repo beside it, and hostnames are
# case-insensitive while names on disk are not. Such a repository keeps being
# served on the forge host, sandboxed.
mkdir -p "$VAULT/collections/demo/repos/my.site.thing.site"
echo '<h1>dotted site</h1>' > "$VAULT/collections/demo/repos/my.site.thing.site/index.html"
check "an ineligible repository is served on the forge host" 200 -D "$TMP/headers" "$BASE/demo/my.site.thing/site/"
body_has "with its content" 'dotted site'
header_has "sandboxed, as before" 'content-security-policy: sandbox'
header_lacks "and not redirected anywhere" 'location:'

# Back to a vault with no sites host, so the checks after this see the default.
printf '{\n  "theme": "paper"\n}\n' > "$VAULT/config.json"
check "removing the setting takes effect on the next request" 200 -D "$TMP/headers" "$BASE/pushed/created/site/"
body_has "and the site is served on the forge host again" 'site ok'
header_has "sandboxed again" 'content-security-policy: sandbox'

# ---- session cookie naming ----

# Cookies are not scoped by origin, so a sibling subdomain of a shared parent
# domain can set one named cofferdam_session with Domain=<parent> and shadow a
# real session. Browsers refuse a __Host- cookie that carries Domain at all,
# and the prefix is legal only with Secure and Path=/, so the name follows the
# scheme.
check "login over plain http" 302 -D "$TMP/headers" "$BASE/login" \
  --data-urlencode username=owner --data-urlencode "token=$OWNER_TOKEN" --data-urlencode next=/
header_has "keeps the bare cookie name" 'set-cookie: cofferdam_session='
header_lacks "since __Host- would need Secure" '__Host-'
check "login behind a TLS proxy" 302 -D "$TMP/headers" -H 'X-Forwarded-Proto: https' "$BASE/login" \
  --data-urlencode username=owner --data-urlencode "token=$OWNER_TOKEN" --data-urlencode next=/
header_has "uses the __Host- prefix" 'set-cookie: __Host-cofferdam_session='
HOST_COOKIE="$({ grep -io 'set-cookie: __Host-cofferdam_session=[^;]*' "$TMP/headers" || true; } | head -1 | sed 's/^[Ss]et-[Cc]ookie: //')"
[ -n "$HOST_COOKIE" ] || { echo "FAIL: no __Host- cookie to present back"; exit 1; }
check "a request presenting the prefixed cookie is signed in" 200 \
  -H 'X-Forwarded-Proto: https' -H "Cookie: $HOST_COOKIE" "$BASE/"
body_has "as the owner" '>owner<'
# A session minted before the prefix existed keeps working, or every signed-in
# browser would be signed out by an upgrade.
BARE_COOKIE="cofferdam_session=$(printf '%s' "$HOST_COOKIE" | sed 's/^__Host-cofferdam_session=//')"
check "the old bare cookie name is still accepted over https" 200 \
  -H 'X-Forwarded-Proto: https' -H "Cookie: $BARE_COOKIE" "$BASE/"
body_has "and resolves to the same user" '>owner<'

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

LFS_STORED="$VAULT/collections/demo/repos/lfsdemo.lfs/${LFS_OID:0:2}/${LFS_OID:2:2}/$LFS_OID"
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
[ -d "$VAULT/collections/fresh/repos/lfsrepo.git" ] || { echo "FAIL: advertisement did not create the repository"; exit 1; }
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
  --data-urlencode "csrf=$CSRF" --data-urlencode "expected=$(git -C "$VAULT/collections/demo/repos/lfsdemo.git" rev-parse main)" \
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
  git -C "$VAULT/collections/demo/repos/lfsdemo.git" cat-file blob main:big.dat | head -1 \
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
[ ! -e "$VAULT/collections/demo/repos/lfsdemo.lfs" ] || { echo "FAIL: .lfs directory survived repository deletion"; exit 1; }
PASS=$((PASS+1)); echo "ok: repository deletion removed its LFS objects"

# ---- Actions: planning, the runner protocol, and the UI ----
#
# Planning, dispatch, cancellation, and the runner API are checked without
# Docker and cost little, so they always run. Actually executing a job needs
# Docker and takes minutes, so those checks are opt-in through SMOKE_SLOW, and
# skip when Docker is absent even then, as the git-lfs client checks do above.

CI_REPO="$TMP/cirepo"
git init -q -b main "$CI_REPO"
mkdir -p "$CI_REPO/.github/workflows" "$CI_REPO/.cofferdam/workflows"

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
# same basename exists under .cofferdam/workflows.
cat > "$CI_REPO/.github/workflows/shadowed.yml" <<'YML'
name: Shadowed by cofferdam
on: [push]
jobs:
  ghost:
    runs-on: ubuntu-latest
    steps:
      - run: echo "this must not run"
YML
cat > "$CI_REPO/.cofferdam/workflows/shadowed.yml" <<'YML'
name: Cofferdam override
on: [push]
jobs:
  real:
    runs-on: ubuntu-latest
    steps:
      - run: echo "the cofferdam copy runs"
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
RUNS="$VAULT/collections/demo/repos/ci.runs"

run_field() { python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],''))" "$1" "$2"; }
job_field() { python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],''))" "$1" "$2"; }
# The run numbers of every run of one workflow, oldest first. Sorted numerically
# and not as text: with ten runs in a repository, "9" sorts after "10" as a
# string, and a caller taking the last field would get the wrong one.
runs_named() {
  python3 - "$RUNS" "$1" <<'PY'
import json, os, sys
base, name = sys.argv[1], sys.argv[2]
out = []
for e in os.listdir(base):
    if not e.isdigit():
        continue
    f = os.path.join(base, e, 'run.json')
    if os.path.exists(f):
        r = json.load(open(f))
        if r['workflowName'] == name: out.append(int(e))
print(' '.join(str(n) for n in sorted(out)))
PY
}
# The engine plans a push's runs after git-receive-pack has already answered
# the client, so a push returns before its runs are on disk. Wait for the
# state rather than guessing at a sleep: under load, planning four workflow
# files takes longer than the one second this used to allow.
wait_runs_at_least() {
  for _ in $(seq 1 150); do
    if [ -d "$RUNS" ] && [ "$(find "$RUNS" -mindepth 2 -maxdepth 2 -name run.json | wc -l)" -ge "$1" ]; then
      return 0
    fi
    sleep 0.2
  done
  echo "FAIL: fewer than $1 runs were planned within 30s"; exit 1
}
wait_run_named() {
  for _ in $(seq 1 150); do
    [ -n "$(runs_named "$1")" ] && return 0
    sleep 0.2
  done
  echo "FAIL: no run named '$1' was planned within 30s"; exit 1
}

git -C "$CI_REPO" push -q "http://owner:$OWNER_TOKEN@127.0.0.1:$PORT/demo/ci" main
# broken.yml, build.yml, and shadowed.yml each plan a run, in that order;
# tagsonly.yml is considered last and must plan none.
wait_runs_at_least 3

[ -d "$RUNS" ] || { echo "FAIL: no .runs directory after a push"; exit 1; }
PASS=$((PASS+1)); echo "ok: push created run state in the vault"

[ -n "$(runs_named 'Build')" ] || { echo "FAIL: the push did not plan the Build workflow"; exit 1; }
PASS=$((PASS+1)); echo "ok: a matching push trigger plans a run"
[ -n "$(runs_named 'Cofferdam override')" ] || { echo "FAIL: .cofferdam/workflows copy did not run"; exit 1; }
PASS=$((PASS+1)); echo "ok: .cofferdam/workflows shadows .github/workflows by basename"
[ -z "$(runs_named 'Shadowed by cofferdam')" ] || { echo "FAIL: the shadowed .github copy ran"; exit 1; }
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
# The rejection itself is a visible run, so waiting for it means the engine
# has decided about this push.
wait_run_named 'badjobid.yml'
[ -z "$(runs_named 'Bad job id')" ] || { echo "FAIL: a path-shaped job id was accepted"; exit 1; }
PASS=$((PASS+1)); echo "ok: a job id shaped like a path is refused rather than written"
[ ! -e "$VAULT/collections/demo/repos/escape.json" ] && [ ! -e "$VAULT/escape.json" ] || {
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

# ---- workflows and runs over the API ----

api "api lists the workflows at a ref" 200 "$BASE/api/repos/demo/ci/workflows"
body_has "with a name" '"name":"Build"'
body_has "and the inputs its dispatch takes" '"greeting"'
body_has "and the parse error on the broken one" '"error"'
api "api lists the runs" 200 "$BASE/api/repos/demo/ci/runs"
body_has "as a named array" '{"runs":\['
body_has "carrying a total" '"total":'
api "a status filter is checked" 400 "$BASE/api/repos/demo/ci/runs?status=sideways"

# The first run of the fixture, whatever number it took.
API_RUN_N="$({ grep -o '"number":[0-9]*' "$BODY" || true; } | head -1 | cut -d: -f2)"
api "api lists the runs again to pick one" 200 "$BASE/api/repos/demo/ci/runs?limit=1"
API_RUN_N="$({ grep -o '"number":[0-9]*' "$BODY" || true; } | head -1 | cut -d: -f2)"
[ -n "$API_RUN_N" ] || { echo "FAIL: no run to read over the API"; exit 1; }
api "api reads one run" 200 "$BASE/api/repos/demo/ci/runs/$API_RUN_N"
body_has "with its jobs" '"jobs":\['
body_has "and their step states" '"stepStates"'
API_JOB="$({ grep -o '"jobs":\[[^]]*' "$BODY" || true; } | head -1 | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)"
if [ -z "$API_JOB" ]; then
  API_JOB="$(python3 -c "
import json,sys,urllib.request
req=urllib.request.Request(sys.argv[1], headers={'authorization':'Bearer '+sys.argv[2]})
d=json.load(urllib.request.urlopen(req))
print(d['jobs'][0]['id'] if d.get('jobs') else '')
" "$BASE/api/repos/demo/ci/runs/$API_RUN_N" "$OWNER_TOKEN")"
fi
[ -n "$API_JOB" ] || { echo "FAIL: the run has no job to read"; exit 1; }
api "api reads one job" 200 "$BASE/api/repos/demo/ci/runs/$API_RUN_N/jobs/$API_JOB"
body_has "with its status" '"status":'
api "api reads a job log" 200 "$BASE/api/repos/demo/ci/runs/$API_RUN_N/jobs/$API_JOB/log"
body_has "saying how many lines there are in all" '"total":'
body_has "and whether it kept only the end" '"truncated":'
api "the whole log is available too" 200 "$BASE/api/repos/demo/ci/runs/$API_RUN_N/jobs/$API_JOB/log?tail=0"
body_has "and says nothing was left out" '"truncated":false'
api "a nonsense tail is refused" 400 "$BASE/api/repos/demo/ci/runs/$API_RUN_N/jobs/$API_JOB/log?tail=-3"
api "an unknown format is refused" 400 "$BASE/api/repos/demo/ci/runs/$API_RUN_N/jobs/$API_JOB/log?format=xml"
api "api lists artifacts" 200 "$BASE/api/repos/demo/ci/runs/$API_RUN_N/artifacts"
api "an unknown run is a 404" 404 "$BASE/api/repos/demo/ci/runs/99999"
api "an unknown job is a 404" 404 "$BASE/api/repos/demo/ci/runs/$API_RUN_N/jobs/nosuchjob"

# Dispatching over the API, which is the same sequence the form performs.
api "api dispatches a workflow" 201 -H "$JSON_CT" \
  --data '{"workflow":".github/workflows/build.yml","ref":"main","inputs":{"greeting":"from the api"}}' \
  "$BASE/api/repos/demo/ci/dispatches"
body_has "reporting the run it planned" '"number":'
API_DISPATCHED="$({ grep -o '"number":[0-9]*' "$BODY" || true; } | head -1 | cut -d: -f2)"
api "a workflow with no dispatch trigger is refused" 400 -H "$JSON_CT" \
  --data '{"workflow":".github/workflows/tagsonly.yml","ref":"main"}' "$BASE/api/repos/demo/ci/dispatches"
api "an unknown workflow is refused" 400 -H "$JSON_CT" \
  --data '{"workflow":".github/workflows/nosuch.yml","ref":"main"}' "$BASE/api/repos/demo/ci/dispatches"
api "an unknown branch is a 404" 404 -H "$JSON_CT" \
  --data '{"workflow":".github/workflows/build.yml","ref":"nosuchbranch"}' "$BASE/api/repos/demo/ci/dispatches"
api_as "dispatching needs push scope" 403 "$NARROW_TOKEN" -H "$JSON_CT" \
  --data '{"workflow":".github/workflows/build.yml","ref":"main"}' "$BASE/api/repos/demo/ci/dispatches"

# Cancelling and re-running. A vault with no runner leaves its runs queued, which
# is exactly the state a cancellation is for.
api "api cancels a queued run" 200 -H "$JSON_CT" --data '{}' "$BASE/api/repos/demo/ci/runs/$API_DISPATCHED/cancel"
body_has "naming it" "\"cancelled\":$API_DISPATCHED"
api "cancelling it again is a conflict, not a 404" 409 -H "$JSON_CT" --data '{}' "$BASE/api/repos/demo/ci/runs/$API_DISPATCHED/cancel"
api "api re-runs it" 200 -H "$JSON_CT" --data '{}' "$BASE/api/repos/demo/ci/runs/$API_DISPATCHED/rerun"
body_has "as a new run" '"number":'

# The command layer over those routes. The login was undone further up, so these
# pass the vault and the token explicitly, which is the other supported way.
ccli() { node dist/index.js "$@" --host "$BASE" --token "$OWNER_TOKEN" --repo demo/ci; }
run_ok "workflow list" ccli workflow list
body_has "naming a workflow" 'Build'
body_has "and the inputs its dispatch takes" 'dispatch: greeting'
run_ok "run list" ccli run list
body_has "with a run number" '#'
run_ok "run list --json" ccli run list --json=number,status
stdout_is_json "as one JSON value"
run_ok "run view" ccli run view "$API_RUN_N"
body_has "naming the workflow" 'Build'
# With several jobs and none of them failed, there is no one log to mean, so it
# asks rather than guessing.
run_code "run view --log asks which job when several could be meant" 2 ccli run view "$API_RUN_N" --log
err_has "naming the option" -- '--job'
run_ok "run view --log with the job named" ccli run view "$API_RUN_N" --log --job "$API_JOB"
run_ok "workflow run dispatches one" ccli workflow run .github/workflows/build.yml --field greeting=cli
body_has "and says how to wait for it" 'run watch'
CLI_RUN="$({ grep -o 'run #[0-9]*' "$BODY" || true; } | head -1 | tr -d 'run #')"
run_ok "run cancel" ccli run cancel "$CLI_RUN"
run_code "cancelling it twice exits 5" 5 ccli run cancel "$CLI_RUN"
run_ok "run rerun" ccli run rerun "$CLI_RUN"
body_has "as a new run" 'Started run #'
# A vault with no runner leaves its runs queued for ever, which is the only way to
# exercise the timeout without waiting for real work.
run_ok "one more run to watch" ccli workflow run .github/workflows/build.yml
CLI_WATCH="$({ grep -o 'run #[0-9]*' "$BODY" || true; } | head -1 | tr -d 'run #')"
run_fails "run watch gives up rather than waiting for ever" ccli run watch "$CLI_WATCH" --interval 1 --timeout 2
body_has "saying so, and what the run was still doing" 'Gave up'
run_ok "and the run can be cancelled afterwards" ccli run cancel "$CLI_WATCH"
run_fails "watching a failed run with --exit-status is a non-zero exit" \
  ccli run watch "$CLI_WATCH" --interval 1 --timeout 20 --exit-status
body_has "reporting the conclusion it did reach" 'cancelled'
run_fails "run download says there are no artifacts" ccli run download "$API_RUN_N"
body_has "plainly" 'no artifacts'

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
RUNNER_TOKEN="$({ grep -o 'cofferdam_runner_[0-9a-f]\{64\}' "$BODY" || true; } | head -1)"
[ -n "$RUNNER_TOKEN" ] || { echo "FAIL: no runner token shown after registration"; exit 1; }
PASS=$((PASS+1)); echo "ok: registering a runner shows its token once"
[ -f "$VAULT/runners.json" ] || { echo "FAIL: runners.json not written"; exit 1; }
grep -q "$RUNNER_TOKEN" "$VAULT/runners.json" && { echo "FAIL: the runner token was stored in the clear"; exit 1; }
PASS=$((PASS+1)); echo "ok: only the runner token's hash is stored"

# The detail page for one runner: what it may do, whether it is there, and the
# start command, which can only carry a placeholder because the token itself is
# not recoverable from the registry.
check "runner detail page" 200 -b "$JAR" "$BASE/admin/runners/smoke"
body_has "naming the repositories it serves" 'demo/\*'
body_has "with the start command" 'cofferdam runner run --host'
body_has "and a placeholder for the unrecoverable token" '&lt;token&gt;'
body_has "offering to regenerate the token" 'Regenerate token'
check "an unknown runner is a 404" 404 -b "$JAR" "$BASE/admin/runners/nosuchrunner"
check "the runners listing again" 200 -b "$JAR" "$BASE/admin/runners"
body_has "linking each runner to its detail page" 'href="/admin/runners/smoke"'

# Regenerating a token, on a runner of its own so the one above keeps working.
check "register a second runner" 200 -b "$JAR" "$BASE/admin/runners" \
  --data-urlencode "csrf=$CSRF" --data-urlencode name=spare --data-urlencode labels=ubuntu-latest \
  --data-urlencode "allow=demo/*"
SPARE_TOKEN="$({ grep -o 'cofferdam_runner_[0-9a-f]\{64\}' "$BODY" || true; } | head -1)"
[ -n "$SPARE_TOKEN" ] || { echo "FAIL: no token shown for the second runner"; exit 1; }
check "the second runner can authenticate" 200 -H "Authorization: Bearer $SPARE_TOKEN" "$BASE/api/runner/whoami"
check "regenerate its token" 200 -b "$JAR" "$BASE/admin/runners/spare/token" --data-urlencode "csrf=$CSRF"
body_has "saying the old one is gone" 'previous token no longer works'
body_has "and giving the command to start with the new one" 'cofferdam runner run --host'
SPARE_TOKEN2="$({ grep -o 'cofferdam_runner_[0-9a-f]\{64\}' "$BODY" || true; } | head -1)"
[ -n "$SPARE_TOKEN2" ] || { echo "FAIL: no new token shown after regeneration"; exit 1; }
[ "$SPARE_TOKEN2" != "$SPARE_TOKEN" ] || { echo "FAIL: regeneration reissued the same token"; exit 1; }
PASS=$((PASS+1)); echo "ok: regeneration issues a different token"
# The old token is checked against the registry rather than by presenting it,
# so this does not spend an attempt against the authentication limiter.
grep -q "$(printf %s "$SPARE_TOKEN" | sha256sum | cut -d' ' -f1)" "$VAULT/runners.json" && {
  echo "FAIL: the old token's hash survived regeneration"; exit 1; }
PASS=$((PASS+1)); echo "ok: the old token's hash is gone from the registry"
check "the new token works" 200 -H "Authorization: Bearer $SPARE_TOKEN2" "$BASE/api/runner/whoami"
body_has "for the same runner, with its labels kept" '"ubuntu-latest"'
check "the detail page notes the rotation" 200 -b "$JAR" "$BASE/admin/runners/spare"
body_has "saying when" 'regenerated'
check "regenerating an unknown runner is a 404" 404 -b "$JAR" "$BASE/admin/runners/nosuchrunner/token" \
  --data-urlencode "csrf=$CSRF"
check "remove the second runner" 302 -b "$JAR" "$BASE/admin/runners/spare/remove" --data-urlencode "csrf=$CSRF"

check "runner whoami" 200 -H "Authorization: Bearer $RUNNER_TOKEN" "$BASE/api/runner/whoami"
body_has "runner identity" '"smoke"'
check "a user token is not a runner token" 401 -H "Authorization: Bearer $OWNER_TOKEN" "$BASE/api/runner/whoami"
check "a runner token is not a user token" 401 -H "Authorization: Bearer $RUNNER_TOKEN" "$BASE/api/whoami"
check "a runner token cannot register runners" 401 -X POST -H "Authorization: Bearer $RUNNER_TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"x","allow":["*"]}' "$BASE/api/runners"
check "runner list over the API" 200 -H "Authorization: Bearer $OWNER_TOKEN" "$BASE/api/runners"
body_has "the registered runner is listed" '"smoke"'

# Liveness, which the registry alone cannot answer: the runner has just called
# whoami, so the vault has seen it, and the runs dispatched above are still
# queued because nothing is executing them.
rcli() { node dist/index.js runner list --host "$BASE" --token "$OWNER_TOKEN"; }
run_ok "runner list reports liveness" rcli
body_has "saying when the runner was last seen" 'seen'
body_has "and what is waiting for one" 'waiting for a runner'
run_ok "runner list --json" node dist/index.js runner list --json --host "$BASE" --token "$OWNER_TOKEN"
stdout_is_json "as one JSON value"
body_has "carrying the liveness field" '"lastSeen"'
body_has "and the queue" '"queued"'
run_code "an unknown field names the ones there are" 2 \
  node dist/index.js runner list --json=nosuchfield --host "$BASE" --token "$OWNER_TOKEN"

# A job acquired with a bogus lease may not be reported on.
check "acquire with an unmatched label yields nothing" 204 -X POST \
  -H "Authorization: Bearer $RUNNER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"labels":["windows-latest"]}' "$BASE/api/runner/acquire"
check "status with a bogus lease is refused" 409 -X POST \
  -H "Authorization: Bearer $RUNNER_TOKEN" -H 'Content-Type: application/json' \
  -H 'X-Cofferdam-Lease: nonsense' -d '{"lease":"nonsense","status":"completed","conclusion":"success"}' \
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

# ---- executing a job (opt-in, and needs Docker) ----

if [ "$SMOKE_SLOW" != 1 ]; then
  echo "skip: executing jobs takes minutes, so it is opt-in; run SMOKE_SLOW=1 (npm run smoke:slow) for it"
elif command -v docker > /dev/null 2>&1 && docker version --format '{{.Server.Version}}' > /dev/null 2>&1; then
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

  # A job that hangs inside a step, to check that timeout-minutes is enforced.
  # Fractional minutes are what keeps this check cheap: the runner multiplies
  # by 60000 and does not round, so 0.1 is six seconds rather than the minute
  # the smallest whole value would cost.
  cat > "$CI_REPO/.github/workflows/timeout.yml" <<'YML'
name: Timeout
on: workflow_dispatch
jobs:
  hang:
    runs-on: ubuntu-latest
    timeout-minutes: 0.1
    steps:
      # Named, so that the log line announcing each step is the name rather
      # than the script. An unnamed run: step is labelled with its own command
      # text, which would put the strings below in the log whether they were
      # ever printed or not, and the checks after this are that they were not.
      - name: Hang
        run: |
          echo "the step started"
          sleep 300
          echo "the step finished"
      - name: After
        run: echo "a later step ran"
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
      - run: echo "base path is $COFFERDAM_SITE_BASE_PATH (was $COFFERDAM_PAGES_BASE_PATH)"
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
  PASS=$((PASS+1)); echo "ok: actions/checkout is substituted by cofferdam's own"
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

  # The lease sweep only notices a runner that stopped heartbeating, and a job
  # stuck inside a step heartbeats perfectly well, so nothing but the runner's
  # own deadline ends this run. Removing the container is what makes the
  # in-flight exec fail; without it the job would sleep for five minutes.
  run_workflow timeout.yml Timeout
  TO_RUN="$RUN_N"
  TO_LOG="$RUNS/$TO_RUN/jobs/hang.log"
  grep -q "the step started" "$TO_LOG" || {
    echo "FAIL: the job that should time out never started"; cat "$TO_LOG"; exit 1; }
  grep -q "exceeded its timeout" "$TO_LOG" || {
    echo "FAIL: timeout-minutes did not stop a job hanging inside a step"; cat "$TO_LOG"; exit 1; }
  PASS=$((PASS+1)); echo "ok: timeout-minutes stops a job hanging inside a step"
  grep -q "the step finished" "$TO_LOG" && {
    echo "FAIL: the hanging step ran to completion anyway"; exit 1; }
  grep -q "a later step ran" "$TO_LOG" && {
    echo "FAIL: a step ran after the job timed out"; exit 1; }
  PASS=$((PASS+1)); echo "ok: a timed-out job runs nothing further"
  [ "$(job_field "$RUNS/$TO_RUN/jobs/hang.json" conclusion)" = "failure" ] || {
    echo "FAIL: a timed-out job did not conclude as a failure"; exit 1; }
  PASS=$((PASS+1)); echo "ok: a timed-out job is a failure, not a cancellation"
  [ "$(run_field "$RUNS/$TO_RUN/run.json" conclusion)" = "failure" ] || {
    echo "FAIL: the run holding a timed-out job did not fail"; exit 1; }
  PASS=$((PASS+1)); echo "ok: the run holding a timed-out job fails with it"

  # upload-artifact reads what the job's container wrote, as the runner's own
  # user. A container runs as root, and on a filesystem that forces a mode on
  # every file it creates - some containers give /tmp one that leaves no
  # execute bit for others - the runner cannot walk back into the directory the
  # job just filled. The artifact would then be empty for a reason that is the
  # filesystem's and not cofferdam's, so probe for it the way the checks above
  # probe for docker and for git-lfs, and say what is being skipped.
  ART_PROBE="$TMP/artifact-probe"
  mkdir -p "$ART_PROBE"
  docker run --rm -v "$ART_PROBE:/probe" "$CI_IMAGE" \
    sh -c 'mkdir -p /probe/d && echo x > /probe/d/f' > /dev/null 2>&1 || true
  ART_READABLE=0
  [ -r "$ART_PROBE/d/f" ] && ART_READABLE=1
  # Removed from inside a container, since what root wrote there this user may
  # not be able to delete.
  docker run --rm -v "$ART_PROBE:/probe" "$CI_IMAGE" rm -rf /probe/d > /dev/null 2>&1 || true
  rmdir "$ART_PROBE" 2>/dev/null || true

  if [ "$ART_READABLE" = 1 ]; then
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

  # The same question on a vault that gives sites a hostname of their own: the
  # site is then at the root of an origin of its own, which the runner cannot
  # work out from the server URL, so the vault has to say so when it hands out
  # the job. A build told /demo/ci/site here would emit a site whose every
  # asset URL is wrong.
  printf '{\n  "theme": "paper",\n  "sites": { "host": "sites.localhost" }\n}\n' > "$VAULT/config.json"
  cat > "$CI_REPO/.github/workflows/sitehost.yml" <<'YML'
name: SiteHost
on: workflow_dispatch
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - id: pages
        uses: actions/configure-pages@v5
      - run: echo "base path is [$COFFERDAM_SITE_BASE_PATH] at ${{ steps.pages.outputs.base_url }}"
YML
  git -C "$CI_REPO" add -A
  git -C "$CI_REPO" -c user.email=ci@example.com -c user.name=ci commit -qm "Add a sites-host workflow"
  git -C "$CI_REPO" push -q "http://owner:$OWNER_TOKEN@127.0.0.1:$PORT/demo/ci" main
  sleep 1
  run_workflow sitehost.yml SiteHost
  grep -q "base path is \[/\] at http://ci--demo.sites.localhost" "$RUNS/$RUN_N/jobs/build.log" || {
    echo "FAIL: configure-pages ignored the vault's sites hostname"
    cat "$RUNS/$RUN_N/jobs/build.log"; exit 1; }
  PASS=$((PASS+1)); echo "ok: configure-pages follows a site to its own origin, where the base path is /"
  printf '{\n  "theme": "paper"\n}\n' > "$VAULT/config.json"
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
    [ -f "$VAULT/collections/demo/repos/ci.site/index.html" ] || {
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
    echo "skip: this runner cannot read what a job container writes (the scratch filesystem forces modes that exclude it); skipping the artifact and site-deployment checks"
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

# ---- backing up the vault to a directory of our own ----

# The whole point of this command is that it needs nothing but HTTP, so it is
# checked here against the same server everything else uses. Three things are
# worth checking beyond "it copied something": that the copy is a vault a server
# will serve, that a second run moves almost nothing, and that a deletion in the
# vault leaves the deleted thing in a snapshot and nowhere else.

# The suite logged out further up, so these name the vault and the token. After a
# `cofferdam login` neither is needed, which is what makes a cron entry the
# command and a directory.
cofferbk() { cli "$@" --host "$BASE" --token "$OWNER_TOKEN"; }

BK="$TMP/backup1"
BACKUP_PORT=$((PORT + 5))
BACKUP_BASE="http://127.0.0.1:$BACKUP_PORT"

# The routes carry vault.json and .secret, so nothing short of admin over the
# whole vault may call them. narrow has push scope over nothing and no admin.
api_as "the manifest refuses a token without whole-vault admin" 403 "$NARROW_TOKEN" "$BASE/api/backup/manifest"
api_as "and so does the fetch" 403 "$NARROW_TOKEN" -X POST -H "$JSON_CT" \
  --data '{"paths":["vault.json"]}' "$BASE/api/backup/fetch"
api "a path that leaves the vault is refused" 400 -X POST -H "$JSON_CT" \
  --data '{"paths":["../../etc/passwd"]}' "$BASE/api/backup/fetch"
body_has "saying it is not a path inside the vault" 'not a path inside the vault'
api "an absolute path too" 400 -X POST -H "$JSON_CT" \
  --data '{"paths":["/etc/passwd"]}' "$BASE/api/backup/fetch"
api "and an unknown exclusion is named rather than ignored" 400 "$BASE/api/backup/manifest?exclude=nosuchthing"

# A repository of its own to delete further down, so that the deletion checks
# disturb nothing the rest of the suite still needs.
run_ok "a repository to delete later" cofferbk repo create demo/gone --description 'here to be deleted'
run_ok "a first backup of the whole vault" cofferbk backup "$BK"
dir_exists "the backup holds a mirror of a repository" "$BK/current/collections/demo/repos/proj.git"
dir_exists "and one of a repository pushed into the vault" "$BK/current/collections/pushed/repos/created.git"
[ -f "$BK/current/vault.json" ] || { echo "FAIL: the backup has no vault.json"; exit 1; }
PASS=$((PASS+1)); echo "ok: the backup carries the vault's own state files"
[ -f "$BK/backup.json" ] || { echo "FAIL: no backup.json in the backup directory"; exit 1; }
PASS=$((PASS+1)); echo "ok: the backup records what it is a backup of"
# A mirror clone writes git's own default description and its own config, so
# these two are the ones a backup has to carry itself.
cmp -s "$VAULT/collections/demo/repos/proj.git/description" "$BK/current/collections/demo/repos/proj.git/description" \
  || { echo "FAIL: the mirror did not get the repository's description"; \
       echo "vault:  [$(cat "$VAULT/collections/demo/repos/proj.git/description" 2>&1)]"; \
       echo "backup: [$(cat "$BK/current/collections/demo/repos/proj.git/description" 2>&1)]"; exit 1; }
PASS=$((PASS+1)); echo "ok: a repository's description came across"
grep -q 'denyDeletes' "$BK/current/collections/pushed/repos/created.git/config" \
  || { echo "FAIL: the mirror did not get the repository's receive settings"; exit 1; }
PASS=$((PASS+1)); echo "ok: a repository's push protections came across"

# The restore path, which is the reason the backup has this shape: serving the
# copy, with no step in between.
node dist/index.js serve "$BK/current" --port "$BACKUP_PORT" > "$TMP/backup-server.log" 2>&1 &
BACKUP_PID=$!
started=0
for _ in $(seq 1 50); do
  if curl -s -o /dev/null "$BACKUP_BASE/"; then started=1; break; fi
  sleep 0.2
done
[ "$started" = 1 ] || { echo "FAIL: the backup did not serve"; cat "$TMP/backup-server.log"; exit 1; }
PASS=$((PASS+1)); echo "ok: the backup directory serves as a vault"
check "a repository browses in the backup" 200 "$BACKUP_BASE/demo/proj"
body_has "with the description the vault had" 'A refreshed description'
check "its file tree is there" 200 "$BACKUP_BASE/demo/proj/tree/main"
check "its issues came across" 200 "$BACKUP_BASE/demo/proj/issues/1"
check "its pull requests too" 200 "$BACKUP_BASE/demo/proj/pulls/1"
check "and a release" 200 "$BACKUP_BASE/demo/proj/releases/tag/v2.0.0"
check "a published site is in the backup" 200 "$BACKUP_BASE/pushed/created/site/"
body_has "with its content" 'site ok'
kill "$BACKUP_PID" 2>/dev/null || true
wait "$BACKUP_PID" 2>/dev/null || true
BACKUP_PID=""

# A snapshot, before the vault is changed, so there is something to compare
# against further down.
run_ok "a snapshot after a sync" cofferbk backup "$BK" --snapshot
SNAP1="$(ls "$BK/snapshots" | head -1)"
[ -n "$SNAP1" ] || { echo "FAIL: --snapshot took no snapshot"; exit 1; }
PASS=$((PASS+1)); echo "ok: a snapshot was taken ($SNAP1)"
dir_exists "the snapshot is a vault of its own" "$BK/snapshots/$SNAP1/collections/demo/repos/proj.git"

# Now change the vault in each of the ways a backup has to notice: a commit
# (which moves a ref), an issue, a comment, and a release.
run_ok "commit a file, moving a ref" \
  cofferbk file write backup-note.md --repo demo/proj --body "written for the backup check" --message "A change"
run_ok "open an issue" cofferbk issue create --repo demo/proj --title "an issue to back up" --body "body" --json=number
BACKUP_ISSUE="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).number)' "$BODY")"
[ -n "$BACKUP_ISSUE" ] || { echo "FAIL: no issue number from issue create"; exit 1; }
run_ok "comment on it" cofferbk issue comment 1 --repo demo/proj --body "a comment to back up"
run_ok "and cut a release" cofferbk release create v2.0.0 --repo demo/proj --title "Backed up" --notes "notes"

# The second run is the one that has to be cheap: only the repository that moved
# is fetched, the rest are skipped without a request, and only the files that
# changed come across.
run_ok "a second backup, incremental" cofferbk backup "$BK" --json
node -e '
  const fs = require("fs");
  const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (s.repos.skipped < 1) { console.error("no repository was skipped: " + JSON.stringify(s.repos)); process.exit(1); }
  if (s.repos.fetched < 1) { console.error("the changed repository was not fetched"); process.exit(1); }
  if (s.repos.cloned !== 0) { console.error("something was cloned again: " + JSON.stringify(s.repos)); process.exit(1); }
  if (s.files.bytes > 100000) { console.error("the second run moved " + s.files.bytes + " bytes"); process.exit(1); }
' "$BODY" || { echo "FAIL: the second backup was not incremental"; head -c 2000 "$BODY"; exit 1; }
PASS=$((PASS+1)); echo "ok: the second run skipped the quiet repositories and moved almost nothing"
grep -rq "an issue to back up" "$BK/current/collections/demo/repos/proj.issues" \
  || { echo "FAIL: the new issue is not in the backup"; exit 1; }
PASS=$((PASS+1)); echo "ok: the new issue is in the backup"
grep -rq "a comment to back up" "$BK/current/collections/demo/repos/proj.issues" \
  || { echo "FAIL: the new comment is not in the backup"; exit 1; }
PASS=$((PASS+1)); echo "ok: the new comment is in the backup"
grep -rq "Backed up" "$BK/current/collections/demo/repos/proj.releases" \
  || { echo "FAIL: the new release is not in the backup"; exit 1; }
PASS=$((PASS+1)); echo "ok: the new release is in the backup"
run_ok "the mirror has the new commit" \
  git --git-dir="$BK/current/collections/demo/repos/proj.git" cat-file -e "main:backup-note.md"

# A second snapshot on the same UTC day replaces the first, because retention
# keeps the newest snapshot of each day rather than every snapshot of it. That is
# what grandfather-father-son means, and it is worth a check of its own: a person
# running this twice in an afternoon should not be surprised later.
run_ok "a second snapshot" cofferbk backup "$BK" --snapshot
SNAP2="$(ls "$BK/snapshots" | tail -1)"
SNAPS="$(ls "$BK/snapshots" | wc -l)"
[ "$SNAPS" = 1 ] || { echo "FAIL: expected one snapshot per day, found $SNAPS"; ls "$BK/snapshots"; exit 1; }
PASS=$((PASS+1)); echo "ok: a second snapshot the same day replaces the first ($SNAP2)"
dir_exists "and it is a vault too" "$BK/snapshots/$SNAP2/collections/demo/repos/proj.git"

# A snapshot costs inodes and not bytes. Measured by asking du about current/ and
# the snapshot together, since du counts a shared inode once: whatever the
# snapshot adds over current/ alone is what it really cost.
CURRENT_KB="$(du -s -k "$BK/current" | cut -f1)"
BOTH_KB="$(du -s -c -k "$BK/current" "$BK/snapshots/$SNAP2" | tail -1 | cut -f1)"
SNAP_KB=$((BOTH_KB - CURRENT_KB))
# Directory entries are real, so this is not zero; it is a small fraction of a
# copy, which is the claim being checked.
[ "$SNAP_KB" -lt "$((CURRENT_KB / 2))" ] \
  || { echo "FAIL: the snapshot cost ${SNAP_KB}kB beside a ${CURRENT_KB}kB current/, so it copied data"; exit 1; }
PASS=$((PASS+1)); echo "ok: the snapshot cost ${SNAP_KB}kB beside a ${CURRENT_KB}kB current/"
LINKS="$(stat -c '%h' "$BK/current/vault.json")"
[ "$LINKS" -ge 2 ] || { echo "FAIL: vault.json has $LINKS link, so the snapshot copied it instead of linking it"; exit 1; }
PASS=$((PASS+1)); echo "ok: a snapshot hardlinks rather than copies (vault.json has $LINKS links)"

# A deletion in the vault reaches current/ and stops there: the snapshots are
# the only place deleted data survives, which is what retention is for.
run_ok "delete the throwaway repository from the vault" cofferbk repo delete demo/gone --yes
rm -rf "$VAULT/collections/demo/repos/proj.issues/$BACKUP_ISSUE"
run_ok "back up after the deletions" cofferbk backup "$BK"
[ ! -e "$BK/current/collections/demo/repos/gone.git" ] || { echo "FAIL: a deleted repository is still in current/"; exit 1; }
PASS=$((PASS+1)); echo "ok: a repository deleted in the vault is gone from current/"
[ ! -e "$BK/current/collections/demo/repos/proj.issues/$BACKUP_ISSUE" ] || { echo "FAIL: a deleted issue is still in current/"; exit 1; }
PASS=$((PASS+1)); echo "ok: a deleted issue is gone from current/"
dir_exists "but the deleted repository is still in the snapshot" "$BK/snapshots/$SNAP2/collections/demo/repos/gone.git"
[ -e "$BK/snapshots/$SNAP2/collections/demo/repos/proj.issues/$BACKUP_ISSUE" ] || { echo "FAIL: the deleted issue is not in the snapshot either"; exit 1; }
PASS=$((PASS+1)); echo "ok: and so is the deleted issue"

run_ok "backup list shows the snapshots" cli backup list "$BK"
body_has "naming one" "$SNAP2"
run_ok "backup verify is clean" cofferbk backup verify "$BK"
body_has "saying what it checked" 'check out against'

# What verify is for: a copy that no longer matches the vault. Both halves are
# checked, since they are found by different means.
printf 'corrupted\n' >> "$BK/current/vault.json"
run_code "verify reports a file that no longer matches" 1 cofferbk backup verify "$BK"
body_has "naming the file" 'vault.json'
# And the sync repairs it, because change detection looks at the copy on disk
# and not only at what the last run recorded.
run_ok "the next run repairs it" cofferbk backup "$BK"
run_ok "and verify is clean again" cofferbk backup verify "$BK"

# Retention, applied without syncing. Keeping one daily snapshot leaves one,
# since both snapshots here were taken on the same UTC day.
run_ok "prune to one daily snapshot" cli backup prune "$BK" --keep-daily 1 --keep-weekly 0 --keep-monthly 0
[ "$(ls "$BK/snapshots" | wc -l)" = 1 ] || { echo "FAIL: prune left $(ls "$BK/snapshots" | wc -l) snapshots"; exit 1; }
PASS=$((PASS+1)); echo "ok: prune applied the retention policy"

# Two runs must not interleave, so a lock nobody is holding is broken and a lock
# somebody is holding is a conflict.
printf '{"pid":1,"host":"%s","started":"now"}\n' "$(hostname)" > "$BK/.lock"
run_code "a second concurrent run exits 5" 5 cofferbk backup "$BK"
err_has "saying another backup is running" 'Another backup is running'
rm -f "$BK/.lock"
printf '{"pid":4194303,"host":"%s","started":"then"}\n' "$(hostname)" > "$BK/.lock"
run_ok "a stale lock is broken with a warning" cofferbk backup "$BK"
body_has "which says so" 'stale lock'

# An exclusion is recorded, so a later run does not have to repeat it, and it
# removes what it excludes from a copy that already had it.
run_ok "a backup that leaves the sites out" cofferbk backup "$BK" --no-sites
[ ! -e "$BK/current/collections/pushed/repos/created.site" ] || { echo "FAIL: --no-sites left the site in the backup"; exit 1; }
PASS=$((PASS+1)); echo "ok: --no-sites removed the site from current/"
run_ok "and the next run remembers" cli backup list "$BK"
body_has "recording the exclusion" 'excluded *sites'

# ---- deleting a repository takes its run history with it ----

check "settings for the ci repo" 200 -b "$JAR" "$BASE/demo/ci/settings"
CSRF="$(csrf_of)"
check "delete the ci repo" 302 -b "$JAR" "$BASE/demo/ci/settings/delete" \
  --data-urlencode "csrf=$CSRF" --data-urlencode confirm=demo/ci
[ ! -e "$VAULT/collections/demo/repos/ci.runs" ] || { echo "FAIL: .runs directory survived repository deletion"; exit 1; }
PASS=$((PASS+1)); echo "ok: repository deletion removed its run history"

# ---- renaming a repository that has accumulated everything ----

# The rename earlier in this suite ran before this repository had pull requests
# or releases, which is how a rename that moved four of its five siblings and
# stranded the fifth went unnoticed. By now demo/proj has issues, a merged pull
# request, and a release, so the round trip here is the one that asks whether
# all of them travel.

dir_exists "the repository has pull requests to move" "$VAULT/collections/demo/repos/proj.pulls"
check "settings before the round trip" 200 -b "$JAR" "$BASE/demo/proj/settings"
CSRF="$(csrf_of)"
check "rename a repository with everything on it" 302 -b "$JAR" "$BASE/demo/proj/settings/rename" \
  --data-urlencode "csrf=$CSRF" --data-urlencode collection=demo --data-urlencode name=fullhouse
check "the renamed repository serves" 200 "$BASE/demo/fullhouse"
# Each of these asks for a specific stored thing rather than for the list that
# would hold it, because an empty list answers 200 just as happily.
check "its issues came along" 200 "$BASE/demo/fullhouse/issues/1"
check "its pull requests came along" 200 "$BASE/demo/fullhouse/pulls/1"
check "its releases came along" 200 "$BASE/demo/fullhouse/releases/tag/v2.0.0"
no_trace_of "nothing of the repository is left under the old name" demo proj
check "settings after the round trip" 200 -b "$JAR" "$BASE/demo/fullhouse/settings"
CSRF="$(csrf_of)"
check "rename it back" 302 -b "$JAR" "$BASE/demo/fullhouse/settings/rename" \
  --data-urlencode "csrf=$CSRF" --data-urlencode collection=demo --data-urlencode name=proj
check "back at its old address" 200 "$BASE/demo/proj/pulls/1"

# ---- repository deletion ----

check "settings for deletion" 200 -b "$JAR" "$BASE/demo/proj/settings"
CSRF="$(csrf_of)"
check "wrong confirm refused" 400 -b "$JAR" "$BASE/demo/proj/settings/delete" \
  --data-urlencode "csrf=$CSRF" --data-urlencode confirm=wrong
check "delete repo" 302 -b "$JAR" "$BASE/demo/proj/settings/delete" \
  --data-urlencode "csrf=$CSRF" --data-urlencode confirm=demo/proj
check "deleted repo is gone" 404 "$BASE/demo/proj"
# Not only the bare repository: a sibling left behind here would be inherited,
# issue and pull request numbers included, by the next repository of this name.
no_trace_of "deletion removed the repository and every sibling of it" demo proj

# ---- an owner token supplied to a new vault ----

# What `cofferdam deploy` relies on: a fresh vault adopts the owner token given
# to it, rather than minting one and printing it. The token is then already in
# the operator's hands, so the server has no reason to log it, and this asserts
# that it does not.

PRESET_VAULT="$TMP/preset-vault"
PRESET_LOG="$TMP/preset.log"
PRESET_PORT=$((PORT + 2))
PRESET_BASE="http://127.0.0.1:$PRESET_PORT"
PRESET_TOKEN="cofferdam_$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
mkdir -p "$PRESET_VAULT"

COFFERDAM_OWNER_TOKEN="$PRESET_TOKEN" node dist/index.js serve "$PRESET_VAULT" \
  --port "$PRESET_PORT" > "$PRESET_LOG" 2>&1 &
PRESET_PID=$!

started=0
for _ in $(seq 1 50); do
  if curl -s -o /dev/null "$PRESET_BASE/"; then started=1; break; fi
  sleep 0.2
done
[ "$started" = 1 ] || { echo "FAIL: server with a supplied owner token did not start"; cat "$PRESET_LOG"; exit 1; }

check "supplied owner token works" 200 -H "authorization: Bearer $PRESET_TOKEN" "$PRESET_BASE/api/whoami"
body_has "it belongs to the owner" '"username":"owner"'
body_has "and the owner may do anything" '"\*"'
check "another token is still refused" 401 -H "authorization: Bearer cofferdam_wrong" "$PRESET_BASE/api/whoami"
grep -q "$PRESET_TOKEN" "$PRESET_LOG" && { echo "FAIL: the server logged the supplied owner token"; exit 1; }
PASS=$((PASS+1)); echo "ok: the supplied token was not echoed into the log"
grep -q "COFFERDAM_OWNER_TOKEN" "$PRESET_LOG" || { echo "FAIL: the log did not say where the owner token came from"; cat "$PRESET_LOG"; exit 1; }
PASS=$((PASS+1)); echo "ok: the log says the token came from the environment"

kill "$PRESET_PID" 2>/dev/null || true
PRESET_PID=""

# A token too short to resist guessing is refused rather than accepted quietly:
# it would otherwise become the owner's credential on a public vault.
mkdir -p "$TMP/short-vault"
if COFFERDAM_OWNER_TOKEN=short node dist/index.js serve "$TMP/short-vault" \
     --port $((PORT + 3)) > "$TMP/short.log" 2>&1; then
  echo "FAIL: a too-short owner token was accepted"; cat "$TMP/short.log"; exit 1
fi
grep -q "not usable" "$TMP/short.log" || { echo "FAIL: no explanation for the refused owner token"; cat "$TMP/short.log"; exit 1; }
[ ! -e "$TMP/short-vault/vault.json" ] || { echo "FAIL: the vault was initialized despite the refused token"; exit 1; }
PASS=$((PASS+1)); echo "ok: a too-short supplied owner token is refused"

# ---- deploy finds flyctl under either of its names ----

# `cofferdam deploy fly` drives flyctl as a child process, and flyctl answers to
# two names: a normal install provides `fly` and `flyctl`, while its own GitHub
# Action unpacks a tarball carrying `flyctl` alone. A deploy that insisted on
# `fly` would fail on a CI runner following the recipe in docs/deploying.md,
# which is the one place nobody is watching to fix a PATH.

FLY_STUB_DIR="$TMP/fly-stub"
NODE_DIR="$(dirname "$(command -v node)")"
mkdir -p "$FLY_STUB_DIR"
cat > "$FLY_STUB_DIR/flyctl" <<'STUB'
#!/bin/sh
echo "$*" >> "$FLY_STUB_CALLS"
exit 1
STUB
chmod +x "$FLY_STUB_DIR/flyctl"
export FLY_STUB_CALLS="$TMP/fly-stub-calls"
: > "$FLY_STUB_CALLS"

# The stub refuses every command, so the deploy stops at the login check. That
# it got that far is the point: the name was resolved and the child ran.
PATH="$FLY_STUB_DIR:$NODE_DIR:/usr/bin:/bin" node dist/index.js deploy fly a-vault \
  --image example.invalid/image:tag > "$TMP/fly-stub.log" 2>&1 && {
  echo "FAIL: a deploy driving a flyctl that refuses everything reported success"
  cat "$TMP/fly-stub.log"; exit 1; }
grep -q "not on PATH" "$TMP/fly-stub.log" && {
  echo "FAIL: flyctl was on PATH under its own name and the deploy did not find it"
  cat "$TMP/fly-stub.log"; exit 1; }
grep -q "auth whoami" "$FLY_STUB_CALLS" || {
  echo "FAIL: the deploy did not run flyctl at all"; cat "$TMP/fly-stub.log"; exit 1; }
PASS=$((PASS+1)); echo "ok: a deploy finds flyctl installed as flyctl rather than fly"

# And with neither name present it says so, rather than reporting whatever a
# missing binary looks like from the inside.
PATH="$NODE_DIR:/usr/bin:/bin" node dist/index.js deploy fly a-vault \
  --image example.invalid/image:tag > "$TMP/fly-missing.log" 2>&1 && {
  echo "FAIL: a deploy with no flyctl at all reported success"; exit 1; }
grep -q "Neither fly nor flyctl is on PATH" "$TMP/fly-missing.log" || {
  echo "FAIL: no useful message when flyctl is absent"; cat "$TMP/fly-missing.log"; exit 1; }
PASS=$((PASS+1)); echo "ok: a deploy with no flyctl says which names it looked for"

# ---- rate limits and abuse controls ----

# A test that trips a limit leaves the limiter tripped for everything after it,
# so these run last and against servers of their own, started on this same vault
# with a limits block written into config.json. The limits and trustProxy are
# read once at startup, which is why a restart is what applies them; the server
# already running read its own configuration and is unaffected.
LIMIT_LOG="$TMP/limits.log"
LIMIT_PORT=$((PORT + 4))
LIMIT_BASE="http://127.0.0.1:$LIMIT_PORT"
LIMIT_PID=""
start_limited() {
  cat > "$VAULT/config.json"
  node dist/index.js serve "$VAULT" --port "$LIMIT_PORT" > "$LIMIT_LOG" 2>&1 &
  LIMIT_PID=$!
  local started=0
  for _ in $(seq 1 50); do
    if curl -s -o /dev/null "$LIMIT_BASE/api/whoami"; then started=1; break; fi
    sleep 0.2
  done
  [ "$started" = 1 ] || { echo "FAIL: the limited server did not start"; cat "$LIMIT_LOG"; exit 1; }
}
stop_limited() {
  [ -n "$LIMIT_PID" ] && kill "$LIMIT_PID" 2>/dev/null || true
  wait "$LIMIT_PID" 2>/dev/null || true
  LIMIT_PID=""
}

# Two failed credential checks per address and username, and the coarse ceiling
# out of the way so that these checks are the only thing counting.
start_limited <<'CONFIG'
{
  "theme": "paper",
  "limits": { "authFailures": 2, "requestsPerMinute": 0, "clone": 1, "search": 1 }
}
CONFIG

check "a wrong login is refused" 401 "$LIMIT_BASE/login" \
  --data-urlencode username=nosuchperson --data-urlencode token=wrong
body_has "with the generic message" 'Invalid username or token'
check "a second wrong login is still refused the same way" 401 "$LIMIT_BASE/login" \
  --data-urlencode username=nosuchperson --data-urlencode token=wrong
body_has "and says no more than before" 'Invalid username or token'
check "the third is throttled" 429 -D "$TMP/headers" "$LIMIT_BASE/login" \
  --data-urlencode username=nosuchperson --data-urlencode token=wrong
header_has "and says when to come back" 'retry-after: [0-9]'
body_has "naming the wait in minutes" 'Try again in [0-9]* minutes\?'
body_lacks "and still saying nothing about the username" 'Invalid username or token'

# A working credential is never charged, so no amount of ordinary signing in
# throttles anyone, and one throttled username does not throttle another.
check "a correct login still works while another username is throttled" 302 "$LIMIT_BASE/login" \
  --data-urlencode username=owner --data-urlencode "token=$OWNER_TOKEN" --data-urlencode next=/
check "and again" 302 "$LIMIT_BASE/login" \
  --data-urlencode username=owner --data-urlencode "token=$OWNER_TOKEN" --data-urlencode next=/
check "and again, past the failure limit" 302 "$LIMIT_BASE/login" \
  --data-urlencode username=owner --data-urlencode "token=$OWNER_TOKEN" --data-urlencode next=/

# The API path, where there is no username in the request at all.
check "a wrong bearer token is refused" 401 -H 'authorization: Bearer cofferdam_wrong' "$LIMIT_BASE/api/whoami"
check "a second wrong bearer token too" 401 -H 'authorization: Bearer cofferdam_wrong' "$LIMIT_BASE/api/whoami"
check "the third is throttled" 429 -D "$TMP/headers" -H 'authorization: Bearer cofferdam_wrong' "$LIMIT_BASE/api/whoami"
header_has "with a Retry-After" 'retry-after: [0-9]'
body_has "and an error object" '"error"'
# A request with no Authorization header presented no credential, so there was
# nothing to get wrong: charging it would let a browser wandering onto an API
# path spend a real client's budget.
for _ in 1 2 3 4; do
  check "a request with no bearer token is never throttled" 401 "$LIMIT_BASE/api/whoami"
done

# The refusal must look the same whether or not the username exists, or it
# becomes a way to enumerate users.
check "a wrong token for a real user is refused" 401 "$LIMIT_BASE/login" \
  --data-urlencode username=owner --data-urlencode token=wrong
check "twice" 401 "$LIMIT_BASE/login" \
  --data-urlencode username=owner --data-urlencode token=wrong
check "and then throttled" 429 "$LIMIT_BASE/login" \
  --data-urlencode username=owner --data-urlencode token=wrong
body_has "with the same message a nonexistent username gets" 'Try again in [0-9]* minutes\?'

# The gate releases its slot on every path out of a request, including one the
# client abandoned. With one slot and a leak, the clone below would queue until
# the gate's timeout and then fail, which is the regression this checks for.
rm -rf "$TMP/gateclone"
run_ok "a clone works with one concurrency slot" \
  git clone -q "$LIMIT_BASE/pushed/created" "$TMP/gateclone"
rm -rf "$TMP/gateclone"
run_ok "and again in sequence, so the slot came back" \
  git clone -q "$LIMIT_BASE/pushed/created" "$TMP/gateclone"
for _ in 1 2 3; do
  curl -sS --max-time 0.05 -o /dev/null "$LIMIT_BASE/pushed/created/info/refs?service=git-upload-pack" 2>/dev/null || true
done
rm -rf "$TMP/gateclone"
run_ok "an abandoned request does not leak the slot" \
  git clone -q "$LIMIT_BASE/pushed/created" "$TMP/gateclone"

# Beyond the gate a search either waits its turn or is refused; what it must
# never do is hang past the queue timeout.
SEARCH_CODES="$(
  for _ in $(seq 1 12); do
    curl -sS -o /dev/null -w '%{http_code}\n' --max-time 20 \
      "$LIMIT_BASE/pushed/created/search?q=e&ref=main" &
  done
  wait
)"
if [ "$(printf '%s\n' "$SEARCH_CODES" | grep -cvE '^(200|503)$')" != 0 ]; then
  echo "FAIL: a gated search answered something other than 200 or 503:"; printf '%s\n' "$SEARCH_CODES"; exit 1
fi
PASS=$((PASS+1)); echo "ok: concurrent searches are answered or refused, never left hanging"

# 0 disables the coarse ceiling, which is what a vault behind a proxy that
# already does this wants.
for _ in $(seq 1 30); do
  curl -sS -o /dev/null "$LIMIT_BASE/" || { echo "FAIL: a request was refused with requestsPerMinute 0"; exit 1; }
done
PASS=$((PASS+1)); echo "ok: requestsPerMinute 0 refuses nothing"
stop_limited

# The coarse ceiling itself, low enough to reach from a test.
start_limited <<'CONFIG'
{
  "theme": "paper",
  "limits": { "requestsPerMinute": 5 }
}
CONFIG
# The startup probe above already spent one request, so the count starts at one.
check "the second request is fine" 200 "$LIMIT_BASE/"
check "the third" 200 "$LIMIT_BASE/"
check "the fourth" 200 "$LIMIT_BASE/"
check "the fifth" 200 "$LIMIT_BASE/"
check "the sixth is refused" 429 -D "$TMP/headers" "$LIMIT_BASE/"
header_has "with a Retry-After" 'retry-after: [0-9]'
# Served from memory or from a package directory, so they are cheaper to answer
# than to count, and a limit that broke the stylesheet would be turned off.
check "the stylesheet is exempt" 200 "$LIMIT_BASE/assets/style.css"
check "and the favicon" 200 "$LIMIT_BASE/favicon.svg"
stop_limited

# Leave the vault as the still-running first server expects to find it.
printf '{\n  "theme": "paper"\n}\n' > "$VAULT/config.json"

# ---- sign out ----

check "sign out" 302 -b "$JAR" -c "$JAR" "$BASE/logout" --data-urlencode "csrf=$CSRF"
check "signed out home" 200 -b "$JAR" "$BASE/"
body_has "sign-in link back" 'Sign in'

echo ""
echo "All $PASS smoke checks passed."
[ "$SMOKE_SLOW" = 1 ] || echo "(job execution was not among them; SMOKE_SLOW=1 includes it)"
