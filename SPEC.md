# hubbit: specification and handoff

This document is the working specification for the hubbit project, written as a handoff to the next implementer. It records the vision, the principles that must survive, the current state of the code in enough detail to build on it without rediscovery, and the questions that remain open. Where a decision is made, we say so plainly; where something is a suggestion, we mark it as one. The previous iteration of this document specified a phase of work ("a web interface that performs operations"); that phase is now implemented and is folded into the description of the current state below.

## 1. What hubbit is

Hosting git repositories usually means one big centralized service (GitHub, GitLab) or a heavyweight self-hosted clone of one. hubbit takes a different shape: a *vault* is a plain directory where each subdirectory is a collection and each subdirectory of a collection is a bare git repository. One small server pointed at a vault provides a web interface, git smart HTTP for clone and push, and a token-based user model, with no database anywhere. Anyone can run a vault: on a laptop, a home server, a VPS, or a cloud platform. The long-term ambition is the full GitHub experience (repository browsing, in-browser editing, issues, pull requests, CI, pages), but delivered as many small federated vaults rather than one central service. We build toward that incrementally, keeping each step small and working.

## 2. Principles (do not break these)

- **The filesystem is the database.** All state lives in the vault directory: repositories are bare git repositories, users and token hashes live in `vault.json`, vault settings in `config.json`, the session signing key is `.secret`, pages sites are sibling directories. Backing up a vault is copying a directory; moving it between machines is the same. No SQLite, no Postgres, no hidden state elsewhere. Future features (issues, pull requests) must also store their state in the vault, either as files or inside git itself.
- **One vault, one machine, one process.** Concurrent writes are mediated by the filesystem and by git's own locking. This is a deliberate trade-off: scaling a vault means a bigger machine, never more of them (the Fly config enforces `--ha=false` for this reason).
- **Anonymous read, token write.** Browsing and cloning require nothing. Every write (git push, API call, UI operation) is authorized by a token whose SHA-256 hash is stored in `vault.json`. Tokens are shown once at minting and never stored in the clear. Web sessions are a convenience layer on top of tokens, not a second credential system.
- **Scopes are globs over `collection/repo`.** A user has push scope (where they may write) and admin scope (where they may manage users and perform destructive administration such as repository deletion). `*` matches everything including `/`. Per-token scopes further restrict a token, and restricted tokens carry no admin rights.
- **The server renders HTML.** No SPA, no client framework, no build step for the frontend. Views are TypeScript template-literal functions with explicit escaping. Small amounts of vanilla JS are acceptable where a control needs it (copy buttons, confirm dialogs, the ref selector). The stylesheet names no colors directly: every color, font, and radius comes from a theme's custom properties (section 3.8), so new markup must use those tokens rather than literal values.
- **The UI, the CLI, and git are three clients of one authorization model.** Nothing should be possible in one that is forbidden in another for the same user, except where noted deliberately (branch deletion, section 3.6).

## 3. Current state

Everything described here is implemented and verified end to end by `scripts/smoke.sh` (262 checks: browsing, sessions, every UI operation, authorization denials, CSRF, themes, the JSON API, git clone/push/push-to-create, pages, Git LFS, repository deletion). The LFS checks run against the local backend, so the suite stays credential-free; the handful that need a real `git lfs` on the host skip with a message when it is absent, and have been run against git-lfs 3.6.1 (push, anonymous clone and pull, the blob card, the raw route, and the edit refusal, all passing). Note that git-lfs derives its endpoint as `<remote>.git/info/lfs`, which is why the `.git`-suffix stripping in `findRepo` is load-bearing here rather than cosmetic.

### 3.1 Running it

```bash
npm install
npm run example        # builds example-root/ with sample collections, repositories, a pages site,
                       # and a dev user (token: hubbit_example_dev_token)
npm run dev            # tsx, serves example-root on http://127.0.0.1:3000
npm run build          # tsc -> dist/
npm run smoke          # end-to-end smoke test against a throwaway vault
node dist/index.js serve /path/to/vault --port 3000
npm link               # optional: puts `hubbit` on PATH
```

First start against a directory with no `vault.json` initializes one and prints a one-time owner token (user `owner`, push scope `*`, admin scope `*`). CLI user commands are remote only: they talk to a running server via `HUBBIT_HOST` and `HUBBIT_TOKEN` (or `--host`/`--token`); there is intentionally no `--vault` flag and no config file. Deployment: `Dockerfile` (node:24-alpine plus git, runs as the node user, volume at `/vault`), `docker-compose.yml` with Caddy for automatic HTTPS given a `DOMAIN`, `fly.toml` plus `scripts/deploy-fly.sh` for Fly.io. The server sets `trust proxy`, so URLs and Secure cookies honor `X-Forwarded-*` behind TLS proxies.

### 3.2 Source layout

| File | Contents |
|---|---|
| `src/index.ts` | CLI: `serve`, `user add`, `user grant`, `user list`, `whoami`; remote API client using fetch |
| `src/server.ts` | App assembly: static assets, module registration order, 404 and error handlers |
| `src/browse.ts` | Read-only HTML routes: home, collection, tree, blob, raw, commits, commit, branches, tags, pages |
| `src/webops.ts` | UI operations: login/logout, new repo, file edit/create/delete, branch and tag ops, settings, user admin |
| `src/githttp.ts` | git smart HTTP: info/refs, upload-pack, receive-pack, push-to-create, HEAD repointing; `checkPushAuth` shared with LFS |
| `src/lfs.ts` | Git LFS (section 3.11): the Batch API, the verify endpoint, and the local backend's transfer routes |
| `src/lfsstore.ts` | LFS object storage: the interface, the local and s3 backends, transfer-URL signing, backend selection from the environment |
| `src/pointer.ts` | Strict LFS pointer-file parser, used by the browse and write-operation routes |
| `src/api.ts` | Bearer-token JSON API used by the CLI |
| `src/ops.ts` | The shared write-operations layer (section 3.5); enforces no authorization itself |
| `src/session.ts` | Signed-cookie sessions, `.secret` management, `Viewer`, CSRF check |
| `src/vault.ts` | `vault.json` load with mtime+size stat cache, token hashing/minting, glob matching, authenticate, `canPush`, `canAdmin`, bootstrap |
| `src/config.ts` | `config.json` load/save (vault settings; currently the theme) |
| `src/themes.ts` | The theme set, the active-theme state, and the custom-property block each theme emits |
| `src/scan.ts` | Vault directory scanning, collection/repo name validation, reserved names, pages dir lookup |
| `src/web.ts` | Helpers shared by the HTML modules: `loadRepo`, `makeCtx`, wildcard/404 utilities |
| `src/views.ts` | Read-page templates (template literals, `esc()` everywhere), `RepoCtx`, layout with sign-in header |
| `src/forms.ts` | Form pages: login, new repo, edit/create/delete file, conflict, settings, admin users, token-shown |
| `src/markdown.ts` | Markdown rendering (section 3.9): markdown-it, KaTeX, highlight.js, the allowlist sanitizer, and the slot mechanism |
| `src/md-plugins.d.ts` | Ambient declarations for the three markdown-it plugins that ship without types |
| `src/render.ts` | highlight.js by extension, HTML escaping, binary sniffing, size and date formatting |
| `src/diff.ts` | Unified-diff to HTML (line classification, per-file boxes) |
| `src/style.ts` | The single structural CSS string; every color and font is a `var(--…)` from the active theme |
| `scripts/create-example.sh` | Builds the example vault, including its `vault.json` with the fixed dev user |
| `scripts/smoke.sh` | The end-to-end smoke test |
| `scripts/deploy-fly.sh` | Idempotent create-app/create-volume/deploy/print-token for Fly |

Route registration order in `server.ts` matters: assets, then the API, then LFS, then git HTTP, then the UI-owned paths (`/login`, `/new`, `/admin/users`, and the repo-level operation routes), then the generic browse routes, then the 404 handler. More-specific wildcard routes are registered before their prefix routes. LFS comes before git HTTP because its paths are more specific than `/:collection/:repo/info/refs`; they do not actually collide, but 3.7 records a past redirect loop caused by Express 4 route ordering, and this removes the question.

### 3.3 HTTP surface

Read routes (anonymous):

| Route | Purpose |
|---|---|
| `GET /` | Collection list |
| `GET /:collection` | Repo list with descriptions and last-update times |
| `GET /:collection/:repo` | Repo home: tree at default branch, README, clone box |
| `GET /:collection/:repo/tree/:ref/*` `blob` `raw` | Browsing; ref may contain `/`, resolved by longest match against real ref names. Markdown blobs render as documents; `?plain=1` shows the source |
| `GET /:collection/:repo/commits/:ref` `commit/:sha` | History (paginated) and diff view |
| `GET /:collection/:repo/branches` `tags` | Ref listings (with operation forms when the session allows) |
| `GET /:collection/:repo/pages/*` | Static site from the sibling `<repo>.pages` directory (index.html, optional 404.html) |
| `GET /:collection/:repo/info/refs` + POST endpoints | git smart HTTP; upload-pack anonymous, receive-pack behind HTTP Basic (401 + WWW-Authenticate), push-to-create |
| `POST /:collection/:repo/info/lfs/objects/batch` | The LFS Batch API; download anonymous, upload behind push scope (401 + `LFS-Authenticate`) |
| `POST /:collection/:repo/info/lfs/objects/verify` | Post-upload integrity check; same authorization as upload |
| `GET/PUT /:collection/:repo/info/lfs/objects/:oid` | Transfer routes for the local backend only, behind an HMAC-signed `exp`/`sig` (400 when the backend is s3) |
| `/:collection/:repo/info/lfs/locks…` | Always 404; file locking is deliberately unimplemented |
| `GET /api/whoami`, `GET/POST /api/users`, `POST /api/users/:name/grant` | Bearer-token JSON API used by the CLI |

UI operation routes (session + CSRF; all POSTs follow POST-redirect-GET):

| Route | Purpose | Requires |
|---|---|---|
| `GET/POST /login`, `POST /logout` | Sign in with username and token; sign out | nothing / session |
| `GET/POST /new` (optional `?collection=`) | Create a repository, optionally with an initial README | push scope over `collection/name` |
| `GET /import` (optional `?collection=`, `?src=`) | Writes the one-line command that imports an existing repository (section 3.10); performs nothing | session, push scope over the target |
| `GET/POST /:collection/:repo/edit/:branch/*path` | Edit a text file (≤ 1 MB), commit to the branch | push scope |
| `GET/POST /:collection/:repo/new/:branch[/*dir]` | Create a file; on an empty repository this creates the branch | push scope |
| `GET/POST /:collection/:repo/delete/:branch/*path` | Delete a file with a confirm step | push scope |
| `POST /:collection/:repo/branches/create` `branches/delete` | Branch operations (default branch is not deletable) | push scope |
| `POST /:collection/:repo/tags/create` `tags/delete` | Lightweight tag operations | push scope |
| `GET/POST /:collection/:repo/settings` | Description and default branch | push scope (page also visible with admin) |
| `POST /:collection/:repo/settings/delete` | Repository deletion after retyping `collection/repo` | admin scope over the repo |
| `GET /admin` | Administration index | admin scope |
| `GET /admin/users`, `POST /admin/users`, `POST /admin/users/:name/grant`, `POST /admin/users/:name/token` | User administration; authorization mirrors the API exactly | admin scope |
| `GET/POST /admin/appearance` | Choose the vault's theme (section 3.8) | admin scope over `*` |

Reserved names (never valid as collection or repo): `vault.json`, `config.json`, `api`, `assets`, `login`, `logout`, `new`, `admin`, `settings`. Anything that becomes a top-level path segment the UI owns must be added here. The LFS routes added nothing, since they are sub-paths of an existing repository route rather than new top-level segments. Repo directories may be named `name` or `name.git`; the suffix is stripped for display and both resolve, which is what lets git-lfs reach the Batch API at the `.git/info/lfs` endpoint it derives on its own.

### 3.4 Web authentication: sessions on top of tokens

Browsers cannot reasonably do per-request token entry, so the UI has a session; there are no passwords and no separate web credential. `POST /login` verifies the username and token against `vault.json` and sets a stateless signed cookie: payload `{u, exp, csrf, ts?}` (username, expiry ~30 days, CSRF value, optional token scope) as base64url JSON plus an HMAC-SHA256, keyed by `<vault>/.secret` (32 random bytes, created on first need, mode 0600; dotfiles are invisible to collection scanning). `HttpOnly`, `SameSite=Lax`, `Secure` when the request came over HTTPS.

Sessions survive server restarts and need no storage. The trade-off is coarse revocation: rotating `.secret` invalidates all sessions, and because abilities are re-derived from live `vault.json` on every request, a user whose tokens are all deleted loses their sessions immediately (a session for a user with zero tokens is treated as invalid). Every mutating form embeds the session's `csrf` value as a hidden field and the handler compares it (timing-safe); this plus `SameSite=Lax` is the CSRF story. Session cookies are never accepted by the git endpoints or the Bearer API, and tokens never grant UI sessions implicitly.

Authorization in the UI: a session resolves to a `Viewer` whose `auth` is shaped exactly like a token authentication result, so `canPush`/`canAdmin` apply unchanged. A session created from a restricted token intersects everything with that token's scope and carries no admin abilities, same as the API rule. Controls the user cannot use are not rendered.

### 3.5 The operations layer

Handlers do not talk to git directly for writes. `src/ops.ts` holds the write operations, each taking explicit arguments and enforcing nothing itself (authorization stays in the route layer, which knows the actor): `createRepo`, `commitFileChange` (create/edit/delete via one entry point), `createBranch`, `deleteBranch`, `createTag`, `deleteTag`, `setDefaultBranch`, `setDescription`, `deleteRepo`. Errors are typed (`OpError` with kinds `invalid`, `notfound`, `exists`, `conflict`, `nochange`) so routes can map them to status codes and pages. The JSON API can later expose the same operations for CLI parity without duplicating logic.

Server-side commits to a bare repo work with a temporary index: `GIT_INDEX_FILE` points at a temp path, `git read-tree <expected-head>` (or `--empty`), the change is staged with `hash-object -w` plus `update-index --cacheinfo` (file mode preserved on edits; deletion feeds a zero-mode entry to `update-index --index-info`, since `--force-remove` insists on a work tree), then `write-tree`, `commit-tree`, and `update-ref refs/heads/<branch> <new> <expected-old>`. The expected-old argument gives optimistic concurrency: the edit form carries the commit sha the user saw, and if the ref moved the update fails cleanly and the UI shows a conflict page rather than clobbering. A no-op edit (identical tree) is refused. Author and committer are `<username> <<username>@noreply.<request host>>`; real emails are an open question (section 7).

### 3.6 Behavioral notes and deliberate asymmetries

- Branch deletion: `receive.denyDeletes` still blocks deletion over git push, while the UI allows it after confirmation; `update-ref -d` bypasses receive hooks, which is exactly what we want. The receive config guards against accidental `push --delete`; the UI is explicit intent. The default branch is never deletable from the UI (change the default first in settings).
- File editing is offered only when the viewed ref is a branch, the viewer has push scope, and the blob is text up to 1 MB. Commits land directly on the branch, GitHub's "commit directly to main" mode; a branch-and-PR flow is a later phase.
- Creating a repository in a new collection creates the collection directory; there is no separate collection-creation flow. The "initialize with a README" option makes the first commit on `main` through the ops layer, and the same create-file flow offers to make the first commit on an empty repository.
- Repository deletion resolves real paths and containment-checks against the vault root before any recursive removal, then removes the repo directory and its `<repo>.pages` sibling.
- Failed logins get one generic message (no username/token distinction).
- The collapsible CLI hints of the read-only era are gone entirely. Operations belong to the UI now, and a page full of `<details>` boxes explaining git commands works against that; keep new pages clean rather than reintroducing them. What remains is genuinely about the command line: the clone box in the repository toolbar and the clone/push commands on the empty-repository page (as GitHub also does). Publishing a pages site is documented in the README rather than hinted at in the interface. The import page (3.10) is the third and last such case: an operation the server deliberately does not perform.

### 3.7 Known limitations and pitfalls for the implementer

- Admin coverage checks a requested glob as a literal target against admin globs (`mycollection/*` covers `mycollection/site` and the literal `mycollection/*`). This is sound for the common shapes but is not true glob subsumption; do not build anything that depends on exotic patterns.
- Express 4 with `'*'` wildcards and `req.params[0]` (via the `wildcard()` helper). Express 5 changes wildcard syntax; do not upgrade casually. Also: route matching is not strict about trailing slashes, which once caused a redirect loop (`/pages` vs `/pages/`); register more-specific wildcard routes before their prefix routes.
- Repositories imported by `git clone --bare` lack the `receive.*` protections; only push-created and UI-created repositories get `denyNonFastForwards`, `denyDeletes`, and `maxInputSize` (2 GiB).
- The collection page runs one `for-each-ref` per repo for last-update times; fine for tens of repositories, unexamined beyond that.
- Raw file serving deliberately uses `text/plain` plus a sandbox CSP for non-image types so repository content cannot inject HTML into the site's origin. Preserve this property in anything new.
- Tokens travel as HTTP Basic passwords on push, so remote vaults need TLS in front (the compose and Fly setups provide it).
- `isValidRepoPath` rejects control characters, so files whose names contain them cannot be browsed or edited; this is a deliberate trade against the newline-delimited git plumbing formats.
- Markdown rendering is the one place where repository content becomes markup on this origin, and it rests on the sanitizer allowlist in `src/markdown.ts`. Treat changes to that allowlist as security changes, and never render a document with the sanitizer disabled.
- Rate limiting and abuse controls for public vaults are unaddressed and acceptable to defer, but say so in the README of any public deployment.
- Git LFS (3.11) carries five limitations worth stating plainly rather than leaving to be discovered. Files already committed as ordinary blobs are unaffected and stay in the packfiles; moving them requires `git lfs migrate import` on a client, which rewrites history. Tree listings show pointer sizes of roughly 130 bytes, since they come from `git ls-tree -l`; correcting this would mean reading every pointer blob in the directory, and the blob page already shows the true size. Commit diffs show pointer diffs, which is git's own behavior without the LFS diff driver. Orphaned objects leak. Object size is capped by `HUBBIT_LFS_MAX_SIZE`, but the cap means different things per backend and the difference is worth knowing before anyone relies on it: the local PUT route enforces it on the bytes as they stream, while in bucket mode the upload never touches this process, so only the size declared in the batch request can be checked. A pusher who understates the size uploads whatever they like, and `verify` catches the mismatch only after the bytes are in the bucket, where they become orphans. Binding `content-length` into the presigned signature would close it, at the risk of refusing uploads from any client that frames the body differently; that trade was not taken here and wants a real bucket to test against. In bucket mode, treat the cap as advisory and put real limits on the bucket. The same asymmetry applies to content: the local route rejects a body that does not hash to the object id, while in bucket mode nothing verifies content, so a pusher can store arbitrary bytes under any object id within a repository they can already push to. Note that push-to-create does survive LFS, though the reason is worth recording since it is not obvious: the batch endpoint 404s for a repository that does not exist, but git fetches the remote's refs before running the pre-push hook that uploads objects, and that advertisement request is what creates the repository (3.3), so by the time the batch call arrives the repository is there. Anything that changes when repositories are created on push must keep this ordering in mind.
- Editing a pointer file through the web interface is refused in both the GET form and the POST handler. This is a correctness requirement rather than a refinement: without it, the in-browser editor lets someone commit ordinary text over a pointer and silently corrupt the repository's LFS state. Deleting a pointer file stays allowed, and the resulting orphan falls under the leak above.

### 3.8 Themes

The interface ships with a set of themes: `paper` (the default), `github`, `slate`, `midnight`, and `terminal`. Matching GitHub exactly is available but is deliberately not the default, so a hubbit vault reads as its own thing while keeping GitHub's conventions and layout.

A theme is a record in `src/themes.ts`: a set of semantic tokens (background, surface, border, accent, tab marker, primary and danger buttons, diff colors, code and input backgrounds, three font stacks, corner radius) plus the name of the highlight.js stylesheet whose token colors suit it. `themeVarsCss()` emits them as custom properties on `:root`, prefixed by a `color-scheme` declaration so browser-native controls follow. The structural CSS in `src/style.ts` references only `var(--…)`, which is what makes adding a theme a one-entry change.

The choice is vault state, not visitor state: one vault is one site. It lives in `<vault>/config.json` (`src/config.ts`, stat-cached like `vault.json`, hand-editable, missing or invalid values falling back to the default rather than failing requests). Because one process serves one vault, the active theme is process state that a middleware re-syncs from the config on each request, rather than a value threaded through every view; concurrent requests always agree, since the value is vault-wide. Stylesheet URLs carry the theme name as a query parameter so a change busts any cache in front of the server.

Setting the theme in the UI (`/admin/appearance`) requires admin scope covering `*`. This is stricter than the rest of user administration on purpose: an administrator delegated to one collection may manage users there, but restyling the whole vault is not theirs to do.
### 3.9 Rendered markdown

Markdown files render as documents rather than as source. `GET /:collection/:repo/blob/:ref/*path` returns rendered HTML for `.md` and `.markdown`, and `?plain=1` returns the highlighted source with line numbers, the spelling GitHub uses. A segmented Preview/Code control in the file's meta bar switches between the two, and the README box on directory pages links to the file so the source view is one click away. `src/markdown.ts` renders both, so the two views cannot drift.

The feature set targets what GitHub renders, since that is what people write their READMEs against: fenced code with highlight.js and a hover copy button, indented code blocks, tables with column alignment, task lists, footnotes, strikethrough, autolinks, emoji shortcodes, heading anchors (GitHub-style slugs, numeric suffix on duplicates, a `#` permalink on hover), alert callouts (`> [!NOTE]` and its four siblings), LaTeX math, and a subset of inline HTML. Relative links and image sources resolve against the file's own directory, with dot segments collapsed so that `../README.md` yields the path a reader would type; the rewriting happens in the sanitizer's tag transform, so links written as HTML are handled the same as links written as markdown. External links get `rel="nofollow noopener noreferrer"`.

Math is rendered on the server by KaTeX: `$…$` inline, `$$…$$` in a block, and ```` ```math ```` fences, all three as on GitHub. Invalid LaTeX renders in red rather than failing the request. KaTeX's stylesheet and fonts are served from the installed package under `/assets/katex/`, so math works on a machine with no outbound network; the font route matches names against a fixed pattern rather than joining a request path. Note that KaTeX output is verbose: a document that is mostly equations can render to twenty times its source size, which the 1 MB source cap bounds but does not make small.

Two properties are load-bearing. First, no document may put active markup on this origin. The rendered HTML passes through an allowlist sanitizer (`sanitize-html`) whose allowlist has no `style` attribute (an inline style could cover the page, which is a phishing surface even without scripting), no event handlers, no scripts, frames, or objects, and only `http`, `https`, `mailto`, and `ftp` URL schemes. This is the same property the raw-serving policy protects, and it is the reason inline HTML can be allowed at all: `<details>`, `<kbd>`, `<sub>`, alignment, and badges all work, while anything executable is discarded. Second, everything renders on the server; no page needs client-side JavaScript to read.

Those two properties conflict with the markup we generate ourselves, since highlighted code carries an inline `onclick` for its copy button and KaTeX emits MathML that the allowlist would strip. Rather than widen the allowlist, such fragments are parked in *slots*: the renderer emits an opaque marker, the sanitizer sees ordinary text, and the fragments are substituted back afterwards. The marker is random per render, so a document cannot forge one. Keep new trusted markup on that path rather than loosening the allowlist.

Mermaid diagrams are the one notable GitHub feature deliberately left out: they would need a multi-megabyte client-side bundle, which the "server renders HTML" principle rules out for now. ```` ```mermaid ```` blocks render as code, which is a reasonable fallback.

### 3.10 Importing an existing repository

Importing is a client-side operation. `git clone --bare` the source, then `git push --mirror` at a vault URL that does not exist yet; push-to-create makes the repository through `ops.createRepo`, so it arrives with the same `receive.*` protections as any other, HEAD pointed at the right branch, and branches and tags in place. `GET /import` writes that command with the collection, the target name, the vault's own host, and the signed-in username filled in, and performs nothing itself.

The clone is `--bare` rather than `--mirror` on purpose: mirroring a GitHub repository drags in `refs/pull/*`, which for a busy repository is thousands of refs the vault has no use for. A bare clone carries branches and tags, and the mirror push then moves exactly those.

We chose this over a server-side import deliberately, and the reasoning should be revisited rather than assumed. A server that clones on the operator's behalf needs outbound network access, a host allowlist and address checks against SSRF, somewhere to put credentials for private sources, a disk budget, and work that outlives a request, which is machinery this project has none of. Doing it on the operator's machine needs none of that: their existing git credentials read the source, their hubbit token writes the vault, and progress and cancellation come from the terminal. The cost is that the data passes through their machine and that bulk import is a shell loop rather than a form. Revisit if a job model arrives for another reason, and note that `import` is a reserved name (`src/scan.ts`) reserved for exactly that possibility.

The command line is assembled from an allowlist, not a URL parse: an https or ssh git URL, or `owner/repo` shorthand for GitHub, with a character set that cannot carry spaces, quotes, or shell metacharacters. This matters more than usual, because the output is text a reader will paste into their own shell. The page also refuses targets outside the viewer's push scope and names that already exist, since both would fail at push time anyway.

### 3.11 Git LFS

A vault keeps every byte ever committed, which is fine for source code and expensive for large binary files: they grow the vault without bound and cannot be pruned without rewriting history. On a deployment with a small attached volume, a single repository holding a few large datasets can dominate the cost of the whole vault. Git LFS replaces those files in the repository with pointer files and stores the bytes elsewhere. The trade-off is latency, since fetching an object is a separate HTTP request rather than bytes already present in a packfile the client just downloaded; that is the intended trade rather than a defect.

We implement the server side of the LFS Batch API. Because the protocol lets the server return an arbitrary URL per object transfer, the s3 backend returns presigned bucket URLs and clients transfer bytes directly to and from the bucket, so large-file content never passes through this process.

**LFS adds no vault state.** Whether a blob is a pointer is determined entirely by reading the blob, so there is no per-repository flag, no marker file, and no probing on the repository page. This is deliberate: it avoids the per-request lookup `hasPages` performs in `src/web.ts`. Do not add a marker file.

Two storage backends sit behind one interface in `src/lfsstore.ts`, constructed once at startup from the environment and threaded through the `register*` functions the way `root` already is. The **s3** backend presigns SigV4 query URLs against any S3-compatible bucket (`aws4fetch`, chosen over hand-rolled SigV4 because canonical-request construction fails silently and is unpleasant to debug). The **local** backend stores objects inside the vault and issues URLs pointing back at hubbit's own transfer routes, so LFS works in `npm run dev`, is covered by the smoke test without credentials, and remains usable on a laptop vault. Object keys and paths are identical in both (`<collection>/<repo>.lfs/<oid[0:2]>/<oid[2:4]>/<oid>`, the sharding git-lfs itself uses on the client), so moving a vault between backends is `rclone copy` and nothing else. The `.lfs` sibling follows the convention `<repo>.pages` set; `listRepoDirs` filters candidates through `isBareRepo`, so such a directory is never mistaken for a repository.

Credentials come from the environment only and must never be written into `config.json` or `vault.json`: the vault is the backup unit and stays portable between deployments with different buckets. Backend selection is `HUBBIT_LFS=off` first, then all four bucket variables present, then none present; **some but not all present is a fatal startup error** that names the missing variables, because a partially configured deployment silently storing large objects on the volume is the exact failure the feature exists to prevent. The README documents the variables and the provider matrix (R2 recommended, Tigris convenient on Fly, S3 with an explicit region).

The local backend's transfer URLs carry `exp` and `sig`, an HMAC-SHA256 over a NUL-delimited payload with an explicit `lfs` domain prefix, keyed by the same `<vault>/.secret` that signs session cookies. The domain prefix is required: it guarantees an LFS href can never be replayed as a session token. Every value that appears in the URL is inside the signed payload, so the download filename cannot be altered, and signatures are compared with `timingSafeEqual` on equal-length buffers. The PUT route streams to a temporary file and renames into place, so an interrupted upload never leaves a corrupt object at the final path, and it rejects content that does not hash to the object id in the path. That validation is available only in the local backend and is worth having where it is cheap; in the bucket configuration the verify endpoint is the only integrity check, since upload bytes bypass the server entirely.

Authorization reuses the existing model exactly: download is anonymous, matching anonymous clone (a public repository must support `git clone` followed by `git lfs pull` with no credentials), and upload goes through the same `checkPushAuth` the git receive-pack path uses, hoisted out of `registerGitHttp` for the purpose. A 401 carries `LFS-Authenticate`, the header git-lfs looks for. No new scope was added.

**Object id validation is the security boundary of `src/lfs.ts`**, playing the same role for object ids that `isValidName` plays for collection and repository names: every oid must match `/^[0-9a-f]{64}$/` before it is used to build a key or a path. `src/lfsstore.ts` re-checks the same things where they become a path or a key, so a future caller that forgets cannot escape the vault or widen a delete prefix.

Two properties of the local transfer route are load-bearing and easy to lose in a refactor. The GET route serves repository bytes from the vault's own origin, so it carries the sandbox CSP and the attachment disposition that 3.7 requires of all raw serving; without them an uploaded HTML or SVG object would be same-origin active content, reachable through an anonymous batch download. And the batch handler collapses repeated object ids to one storage lookup before fanning out: download needs no credentials, so a request repeating one id up to the 1000-object limit would otherwise multiply into that many bucket operations.

Deliberate non-goals, recorded so a later implementer does not read them as omissions: the file locking API (404 by design, which git-lfs reads as unsupported), orphan garbage collection (documented as a leak; a real collector must enumerate every pointer blob reachable from every ref across all history, which is expensive and error-prone), multipart upload (the `basic` adapter does a single PUT, hence the size cap), server-side conversion of existing files (that is `git lfs migrate import` on a client, which rewrites history), transfer adapters other than `basic`, true file sizes in tree listings, and bucket storage for pages sites or repository data. The storage module is meant to be reusable for that last one, but the pages implementation was left alone.

Repository deletion removes stored objects too. `deleteRepo` is async for it, and the removal is best-effort: by the time it runs the repository directory is already gone and the objects are unreachable garbage, so a storage failure is logged rather than allowed to fail the deletion.

## 4. Later phases, sketched

- **Issues.** State must live in the vault. Two candidate designs: a sibling directory (`<repo>.issues/` with one markdown-plus-frontmatter file per issue), which is transparent and greppable; or a hidden git ref inside the repo (as git-bug and similar tools do), which travels with clones. We lean toward the sibling directory for consistency with pages, but this is undecided.
- **Pull requests.** Within a vault, a PR can be branch-to-branch with a merge button (server-side `git merge-tree`/`merge` in a temp worktree or index). Across vaults is the federation question below.
- **Pages build hook.** A post-receive hook (or an in-server hook after receive-pack completes, which we already have a hook point for) that builds `<repo>.pages` from the repo, growing into general CI later.
- **JSON everywhere.** Content negotiation on the read routes, the ops layer exposed through the API for CLI parity, `--json` on the CLI, and a raw `hubbit api` passthrough command.
- **Federation.** The distinctive long-term idea: vault-to-vault interaction (forking a repo from another vault, cross-vault pull requests, identity assertions between vaults). Nothing is designed yet; do not let near-term features paint this into a corner (for example, keep repository identity as `host/collection/repo`-shaped in any stored references).
- **Published container images and CI for hubbit itself**, once the project is hosted somewhere with CI.

## 5. Security notes for the next implementer

Escaping is manual (`esc()` in views); every new interpolation into HTML must go through it, and command arguments must keep using `execFile` arrays, never a shell. Validate every collection/repo/ref/path from a URL or form with the existing validators before it reaches git; ref names additionally must not start with `-`. LFS object ids are the same kind of boundary and get the same treatment (3.11): validate against `/^[0-9a-f]{64}$/` before building any key or path from one, and keep the `lfs` domain prefix on transfer signatures, since `.secret` also signs session cookies. The raw-serving content-type policy (3.7) must survive any refactor. So must the markdown sanitizer (3.9): rendered documents are attacker-controlled markup on the site's origin, and an escape there hands a repository writer any reader's session. Session cookies must never be accepted for the git or Bearer API endpoints, and tokens never grant UI sessions implicitly; the two credential presentations stay distinct. Deletion paths (`deleteRepo`) must resolve and containment-check against the vault root before any recursive removal. Every mutating route re-derives abilities from live `vault.json` and checks CSRF; keep both properties when adding routes.

## 6. Housekeeping

The verification style is `scripts/smoke.sh` plus manual curl and git against the example vault; extend the smoke test with each new feature, since it is the only automated check. The dev loop is `npm run dev` against `example-root`; regenerate it any time with `rm -rf example-root && npm run example` (the example vault's `vault.json`, with its fixed dev token, is recreated by the script). `npm link` is set up for the `hubbit` binary. Self-hosting the project in a vault would be fitting once a public vault exists.

## 7. Open questions

1. Web identity beyond tokens: per-user passwords, or OIDC per vault, or nothing more?
2. Real names and emails for commit authorship (a `displayName`/`email` field on user records?), versus the current `username@noreply.<host>` placeholder.
3. Issue and PR storage format (sibling directory versus in-repo refs), and whether issues get IDs that survive repo renames.
4. Session revocation granularity: is rotate-the-secret acceptable, or do sessions need server-side state eventually?
5. Multi-tenant hosting (a vault per account on shared infrastructure) as a product, versus staying purely self-hosted.
6. Repository renames and transfers, which interact with issue IDs, pages directories, and clone URLs.
7. Whether `receive.maxInputSize` and the `deny*` configs should be applied retroactively to imported repositories by a vault-check command.
8. User deletion and token revocation in the UI (today the escape hatch is hand-editing `vault.json`).
9. Whether a visitor should be able to override the vault's theme for themselves (a cookie, or following `prefers-color-scheme` when the vault picks a light theme), versus the current position that the theme belongs to the vault.
10. Whether a vault should ever import server-side (section 3.10), which is the same question as whether it grows a background-job model.
