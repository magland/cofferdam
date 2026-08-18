#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:?usage: create-example.sh <root-dir>}"

if [ -e "$ROOT" ]; then
  echo "error: $ROOT already exists; remove it first" >&2
  exit 1
fi

mkdir -p "$ROOT"
ROOT="$(cd "$ROOT" && pwd)"

new_workdir() {
  local tmp
  tmp="$(mktemp -d)"
  git -C "$tmp" init -q -b main
  git -C "$tmp" config user.name "Example Author"
  git -C "$tmp" config user.email "author@example.org"
  echo "$tmp"
}

publish() {
  local tmp="$1" collection="$2" name="$3" desc="$4"
  mkdir -p "$ROOT/$collection"
  git clone --bare -q "$tmp" "$ROOT/$collection/$name.git"
  echo "$desc" > "$ROOT/$collection/$name.git/description"
  rm -rf "$tmp"
}

# ---- alice/hello-numerics ----

T="$(new_workdir)"
cat > "$T/README.md" <<'EOF'
# hello-numerics

A small collection of numerical routines used as example content.

## Usage

```python
from src.compute import mean
print(mean([1, 2, 3]))
```

See [the notes](docs/notes.md) for background.
EOF
mkdir -p "$T/src" "$T/docs"
cat > "$T/src/compute.py" <<'EOF'
"""Basic numerical routines."""


def mean(xs):
    if len(xs) == 0:
        raise ValueError("mean of empty sequence")
    return sum(xs) / len(xs)


def variance(xs):
    m = mean(xs)
    return sum((x - m) ** 2 for x in xs) / len(xs)
EOF
cat > "$T/docs/notes.md" <<'EOF'
# Notes

These routines are intentionally simple. They exist to give the file browser something to display.
EOF
git -C "$T" add -A
git -C "$T" commit -q -m "Initial commit with mean and variance"

cat > "$T/src/util.py" <<'EOF'
def clamp(x, lo, hi):
    return max(lo, min(hi, x))
EOF
git -C "$T" add -A
git -C "$T" commit -q -m "Add clamp utility"
git -C "$T" tag v0.1.0

cat >> "$T/src/compute.py" <<'EOF'


def stddev(xs):
    return variance(xs) ** 0.5
EOF
git -C "$T" add -A
git -C "$T" commit -q -m "Add stddev" -m "Computed as the square root of the population variance. This commit also demonstrates a multi-line commit message body."

git -C "$T" checkout -q -b dev
cat > "$T/src/experimental.py" <<'EOF'
def median(xs):
    ys = sorted(xs)
    n = len(ys)
    if n == 0:
        raise ValueError("median of empty sequence")
    mid = n // 2
    if n % 2 == 1:
        return ys[mid]
    return (ys[mid - 1] + ys[mid]) / 2
EOF
git -C "$T" add -A
git -C "$T" commit -q -m "Experimental median implementation"
git -C "$T" checkout -q main

cat > "$T/Makefile" <<'EOF'
test:
	python -m pytest
EOF
git -C "$T" add -A
git -C "$T" commit -q -m "Add Makefile"
git -C "$T" tag v0.2.0

publish "$T" alice hello-numerics "Small numerical routines (example repository)"

# ---- alice/webapp ----

T="$(new_workdir)"
cat > "$T/README.md" <<'EOF'
# webapp

A tiny static web page, used to exercise HTML, CSS, and TypeScript highlighting.
EOF
cat > "$T/index.html" <<'EOF'
<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>webapp</title>
    <link rel="stylesheet" href="styles.css">
  </head>
  <body>
    <h1>Hello</h1>
    <script src="main.js"></script>
  </body>
</html>
EOF
cat > "$T/styles.css" <<'EOF'
body {
  font-family: sans-serif;
  margin: 2rem;
}
EOF
git -C "$T" add -A
git -C "$T" commit -q -m "Initial page"

cat > "$T/main.ts" <<'EOF'
interface Greeting {
  who: string;
}

function greet(g: Greeting): string {
  return `Hello, ${g.who}`;
}

console.log(greet({ who: "world" }));
EOF
git -C "$T" add -A
git -C "$T" commit -q -m "Add TypeScript entry point"

publish "$T" alice webapp "A tiny static web page (example repository)"

mkdir -p "$ROOT/alice/webapp.pages"
cat > "$ROOT/alice/webapp.pages/index.html" <<'EOF'
<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>webapp pages</title>
    <link rel="stylesheet" href="styles.css">
  </head>
  <body>
    <h1>webapp</h1>
    <p>This site is served from the <code>alice/webapp.pages</code> directory, next to the bare repository.</p>
    <p><a href="about.html">About</a></p>
  </body>
</html>
EOF
cat > "$ROOT/alice/webapp.pages/styles.css" <<'EOF'
body { font-family: sans-serif; margin: 3rem auto; max-width: 40rem; padding: 0 1rem; }
h1 { color: #2a6f97; }
EOF
cat > "$ROOT/alice/webapp.pages/about.html" <<'EOF'
<!doctype html>
<html>
  <head><meta charset="utf-8"><title>About</title><link rel="stylesheet" href="styles.css"></head>
  <body><h1>About</h1><p>A minimal example pages site.</p><p><a href="./">Home</a></p></body>
</html>
EOF
cat > "$ROOT/alice/webapp.pages/404.html" <<'EOF'
<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Not found</title><link rel="stylesheet" href="styles.css"></head>
  <body><h1>404</h1><p>No such page here.</p><p><a href="./">Home</a></p></body>
</html>
EOF

# ---- bob/notes ----

T="$(new_workdir)"
cat > "$T/README.md" <<'EOF'
# notes

Plain markdown notes, nothing else.
EOF
cat > "$T/2026-01-ideas.md" <<'EOF'
# Ideas

- A filesystem-backed git host
- Pages sites built from a branch
EOF
git -C "$T" add -A
git -C "$T" commit -q -m "Start notes"
cat > "$T/2026-02-followup.md" <<'EOF'
# Follow-up

The directory layout is root/collection/repo.git. No database is involved.
EOF
git -C "$T" add -A
git -C "$T" commit -q -m "Add follow-up note"

publish "$T" bob notes "Markdown notes (example repository)"

# ---- bob/empty ----

mkdir -p "$ROOT/bob"
git init -q --bare -b main "$ROOT/bob/empty.git"
echo "An empty repository for testing" > "$ROOT/bob/empty.git/description"

# ---- vault.json with a dev user (fixed token, example vault only) ----

DEV_TOKEN="hubbit_example_dev_token"
DEV_HASH="$(printf %s "$DEV_TOKEN" | sha256sum | cut -d' ' -f1)"
cat > "$ROOT/vault.json" <<EOF
{
  "users": {
    "dev": {
      "tokens": [{ "hash": "$DEV_HASH" }],
      "scope": ["*"],
      "admin": ["*"]
    }
  }
}
EOF

echo "Example content created under $ROOT"
echo ""
echo "Sign in on the web (or push) as user 'dev' with token: $DEV_TOKEN"
echo "This fixed token is for the example vault only."
