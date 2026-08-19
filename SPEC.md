# cofferdam: specification and handoff

This document is the working specification for the cofferdam project, written as a handoff to the next implementer. It records the vision, the principles that must survive, the current state of the code in enough detail to build on it without rediscovery, and the questions that remain open. Where a decision is made, we say so plainly; where something is a suggestion, we mark it as one. The previous iteration of this document specified a phase of work ("a web interface that performs operations"); that phase is now implemented and is folded into the description of the current state below.

## 1. What cofferdam is

cofferdam is a self-hosted git forge with the shape of GitHub, meant to be run by the people whose repositories it holds. It serves a *vault*: a plain directory in which each subdirectory is a collection and each subdirectory of a collection is a bare git repository. One small server pointed at a vault provides the web interface (browsing, in-browser editing, issues, pull requests, releases, Actions-compatible workflows, static sites), git smart HTTP for clone and push, Git LFS, and a token-based user model. Anyone can run a vault: on a laptop, a home server, a VPS, or a cloud platform, and moving one between those is copying a directory.

The comparison that matters is with the self-hosted forges (GitLab, Gitea, Forgejo) rather than with GitHub itself. Against those, the claim is not more features but a smaller thing to operate: one process, no database, no queue, no separate CI service, and state you can read with `ls` and back up with `cp`. Against GitHub, the trade is the network: a vault is self-contained, with no shared identity between vaults, no notifications across them, and no pull request that crosses from one to another. We build toward the GitHub feature set incrementally, keeping each step small and working.

## 2. Principles (do not break these)

- **The filesystem is the database.** All state lives in the vault directory: repositories are bare git repositories, users and token hashes live in `vault.json`, vault settings in `config.json`, the session signing key is `.secret`, static sites are sibling directories, and workflow runs and their logs live in `<repo>.runs/`. Backing up a vault is copying a directory; moving it between machines is the same. No SQLite, no Postgres, no hidden state elsewhere. Issues and pull requests follow the same rule, as markdown files in `<repo>.issues/` and `<repo>.pulls/`, and any future feature must too, either as files or inside git itself.
- **One vault, one machine, one process.** Concurrent writes are mediated by the filesystem and by git's own locking. This is a deliberate trade-off: scaling a vault means a bigger machine, never more of them (the Fly config enforces `--ha=false` for this reason).
- **Anonymous read, token write.** Browsing and cloning require nothing. Every write (git push, API call, UI operation) is authorized by a token whose SHA-256 hash is stored in `vault.json`. Tokens are shown once at minting and never stored in the clear. Web sessions are a convenience layer on top of tokens, not a second credential system.
- **Scopes are globs over `collection/repo`.** A user has push scope (where they may write) and admin scope (where they may manage users and perform destructive administration such as repository deletion). `*` matches everything including `/`. Per-token scopes further restrict a token, and restricted tokens carry no admin rights.
- **The server renders HTML.** No SPA, no client framework, no build step for the frontend. Views are TypeScript template-literal functions with explicit escaping. Small amounts of vanilla JS are acceptable where a control needs it (copy buttons, confirm dialogs, the ref selector). The stylesheet names no colors directly: every color, font, and radius comes from a theme's custom properties (section 3.8), so new markup must use those tokens rather than literal values.
- **The UI, the CLI, and git are three clients of one authorization model.** Nothing should be possible in one that is forbidden in another for the same user, except where noted deliberately (branch deletion, section 3.6).

## 3. Current state

Everything described here is implemented and verified end to end by `scripts/smoke.sh` (392 checks: browsing, sessions, every UI operation, authorization denials, CSRF, themes, the JSON API, git clone/push/push-to-create, sites, Git LFS, workflow planning and execution, JavaScript and composite actions, artifacts, the action cache, site deployment, repository deletion). The LFS checks run against the local backend, so the suite stays credential-free; the handful that need a real `git lfs` on the host skip with a message when it is absent, and have been run against git-lfs 3.6.1 (push, anonymous clone and pull, the blob card, the raw route, and the edit refusal, all passing). Note that git-lfs derives its endpoint as `<remote>.git/info/lfs`, which is why the `.git`-suffix stripping in `findRepo` is load-bearing here rather than cosmetic.

### 3.1 Running it

```bash
npm install
npm run example        # builds example-root/ with sample collections, repositories, a site,
                       # and a dev user (token: cofferdam_example_dev_token)
npm run dev            # tsx, serves example-root on http://127.0.0.1:3000
npm run build          # tsc -> dist/
npm run smoke          # end-to-end smoke test against a throwaway vault
node dist/index.js serve /path/to/vault --port 3000
npm link               # optional: puts `cofferdam` on PATH
```

First start against a directory with no `vault.json` initializes one and prints a one-time owner token (user `owner`, push scope `*`, admin scope `*`). CLI user commands are remote only: they talk to a running server, and the server and token come from `cofferdam login` (or `--host`/`--token` per command); there are intentionally no environment variables and no `--vault` flag. Login records the vault URL in `~/.config/cofferdam/login.json` and hands the token to git's credential store, so the token is kept in one place, the one git already reads for pushing. Deployment: `Dockerfile` (node:24-alpine plus git, runs as the node user, volume at `/vault`), `docker-compose.yml` with Caddy for automatic HTTPS given a `DOMAIN`, `fly.toml` plus `scripts/deploy-fly.sh` for Fly.io. The server sets `trust proxy`, so URLs and Secure cookies honor `X-Forwarded-*` behind TLS proxies.

### 3.2 Source layout

| File | Contents |
|---|---|
| `src/index.ts` | CLI: `serve`, `user …`, `runner …`, `whoami`, `login`/`logout`; remote API client using fetch |
| `src/server.ts` | App assembly: static assets, module registration order, 404 and error handlers |
| `src/browse.ts` | Read-only HTML routes: home, collection, tree, blob, raw, commits, commit, branches, tags, site |
| `src/webops.ts` | UI operations: login/logout, new repo, file edit/create/delete, branch and tag ops, settings, user admin |
| `src/githttp.ts` | git smart HTTP: info/refs, upload-pack, receive-pack, push-to-create, HEAD repointing; `checkPushAuth` shared with LFS |
| `src/lfs.ts` | Git LFS (section 3.11): the Batch API, the verify endpoint, and the local backend's transfer routes |
| `src/lfsstore.ts` | LFS object storage: the interface, the local and s3 backends, transfer-URL signing, backend selection from the environment |
| `src/pointer.ts` | Strict LFS pointer-file parser, used by the browse and write-operation routes |
| `src/api.ts` | Bearer-token JSON API used by the CLI |
| `src/git.ts` | `execGit` and `GitRepo`: every read the interface makes of a repository, and the ref/path/sha validators the routes check against |
| `src/ci/expr.ts` | The `${{ }}` expression language; used by the server and the runner alike |
| `src/ci/workflow.ts` | Workflow-file parsing and normalization, and the branch/tag/path filter matcher |
| `src/ci/engine.ts` | The CI planner and scheduler (3.12): discovery, matrix, `needs`, concurrency, leases |
| `src/ci/runs.ts` | Run state on disk under `<repo>.runs/`, and retention |
| `src/ci/runners.ts` | The runner registry in `runners.json` and runner authentication |
| `src/ci/protocol.ts` | The runner protocol's wire types, shared by both sides |
| `src/ci/actionref.ts` | Parsing the `uses:` value of a step |
| `src/ci/artifacts.ts` | Artifact storage in a run's directory, and publishing one as a repository's site |
| `src/ci/api.ts` | The runner-facing API, artifacts, site deployment, and runner registration |
| `src/ci/web.ts` | The Actions pages and their operations |
| `src/ci/views.ts` | Actions page templates |
| `src/ci/present.ts` | The memoized check behind showing the Actions tab |
| `src/runner/client.ts` | `cofferdam runner run`: the poll loop, log shipping, and status reporting |
| `src/runner/docker.ts` | Container lifecycle and exec, as thin wrappers over the `docker` CLI |
| `src/runner/context.ts` | Container paths, the environment, expression contexts, and the workflow-command and file-command parsers |
| `src/runner/steps.ts` | The step engine: `run` steps, JavaScript and composite actions, post hooks |
| `src/runner/actions.ts` | Fetching and caching actions, and reading `action.yml` |
| `src/runner/externals.ts` | Providing a node interpreter to the container when the image has none |
| `src/runner/overrides.ts` | The actions cofferdam implements itself (3.12) |
| `src/runner/job.ts` | Orchestrating one job: workspace, container, step loop, conclusion |
| `src/runner-cli.ts` | The `cofferdam runner` subcommands |
| `src/ops.ts` | The shared write-operations layer (section 3.5); enforces no authorization itself |
| `src/session.ts` | Signed-cookie sessions, `.secret` management, `Viewer`, CSRF check |
| `src/vault.ts` | `vault.json` load with mtime+size stat cache, token hashing/minting, glob matching, authenticate, `canPush`, `canAdmin`, bootstrap |
| `src/credentials.ts` | The client side of authentication: `cofferdam login`/`logout` talking to git's own credential store, so clone, fetch, push, and git-lfs stop asking. No vault state |
| `src/config.ts` | `config.json` load/save (vault settings: the theme, and CI run retention) |
| `src/themes.ts` | The theme set, the active-theme state, and the custom-property block each theme emits |
| `src/scan.ts` | Vault directory scanning, collection/repo name validation, reserved names, site dir lookup |
| `src/web.ts` | Helpers shared by the HTML modules: `loadRepo`, `makeCtx`, wildcard/404 utilities |
| `src/views.ts` | Read-page templates (template literals, `esc()` everywhere), `RepoCtx`, layout with sign-in header |
| `src/forms.ts` | Form pages: login, new repo, edit/create/delete file, conflict, settings, admin users, token-shown |
| `src/markdown.ts` | Markdown rendering (section 3.9): markdown-it, KaTeX, highlight.js, the allowlist sanitizer, and the slot mechanism |
| `src/md-plugins.d.ts` | Ambient declarations for the three markdown-it plugins that ship without types |
| `src/render.ts` | highlight.js by extension, HTML escaping, binary sniffing, size and date formatting |
| `src/logo.ts` | The mark and the logotype, drawn as SVG paths so the name needs no font and no static file |
| `src/diff.ts` | Unified-diff to HTML (line classification, per-file boxes) |
| `src/style.ts` | The single structural CSS string; every color and font is a `var(--…)` from the active theme |
| `src/icons.ts` | The icon set: monoline glyphs drawn as SVG on a 24-unit grid, and the `icon()` wrapper |
| `src/find.ts` | Finding things in a repository: the file finder (every path at a ref, filtered in the browser) and the text search route |
| `src/pulls.ts` | The pull request store under `<repo>.pulls/` |
| `src/pullweb.ts` | The pull request pages, and the merge button over `ops.mergeBranch` |
| `src/releases.ts` | Releases: the store under `<repo>.releases/`, the pages, and the write routes |
| `src/atom.ts` | Atom feed construction, shared by the release and history feeds |
| `src/avatar.ts` | Identicons: the drawing a name gets in place of an uploaded picture |
| `src/languages.ts` | The language breakdown: Linguist's names and colours by extension, and the byte shares the About panel's bar is drawn from |
| `src/compare.ts` | Comparing two revisions: the route and its page |
| `src/multipart.ts` | multipart/form-data parsing, for the upload form |
| `src/issues.ts` | The issue store: `<repo>.issues/` on disk, and the validation over it |
| `src/issueweb.ts` | The issue pages and their operations |
| `scripts/create-example.sh` | Builds the example vault, including its `vault.json` with the fixed dev user |
| `scripts/smoke.sh` | The end-to-end smoke test |
| `scripts/deploy-fly.sh` | Idempotent create-app/create-volume/deploy/print-token for Fly |

Route registration order in `server.ts` matters: assets, then the API (including the CI and runner API), then LFS, then git HTTP, then the CI web routes, then the UI-owned paths (`/login`, `/new`, `/admin/users`, and the repo-level operation routes), then the generic browse routes, then the 404 handler. More-specific wildcard routes are registered before their prefix routes. LFS comes before git HTTP because its paths are more specific than `/:collection/:repo/info/refs`; they do not actually collide, but 3.7 records a past redirect loop caused by Express 4 route ordering, and this removes the question.

### 3.3 HTTP surface

Read routes (anonymous):

| Route | Purpose |
|---|---|
| `GET /` | Collection list |
| `GET /:collection` | Repo list with descriptions and last-update times |
| `GET /:collection/:repo` | Repo home: tree at default branch, README, clone box |
| `GET /:collection/:repo/tree/:ref/*` `blob` `raw` | Browsing; ref may contain `/`, resolved by longest match against real ref names. Markdown blobs render as documents; `?plain=1` shows the source |
| `GET /:collection/:repo/commits/:ref[/*path]?author=` | History (paginated), narrowed to a path and to an author when either is given (`-F`, so both are literal) |
| `GET /:collection/:repo/commit/:sha` | The diff view for one commit |
| `GET /:collection/:repo/search?q=&ref=` | Literal text search over the files at a ref (`git grep`, fixed strings, bounded in results and in time); an unknown ref falls back to the default branch |
| `GET /:collection/:repo/find[/:ref]` | The file finder: every path at the ref (capped at 20,000), filtered in the browser as you type; without a ref, the default branch |
| `GET /:collection/:repo/find[/:ref]` | The file finder: every path at a ref, filtered in the browser |
| `GET /:collection/:repo/blame/:ref/*path` | Blame for one text file; binary or over-large files redirect to the blob page |
| `GET /:collection/:repo/releases`, `releases/tag/*` | Releases: notes attached to a tag, from `<repo>.releases/<tag>.md` |
| `GET /:collection/:repo/pulls`, `pulls/:n` | Pull requests: the list (`?state=`) and one pull request with its thread, commits, and diff |
| `GET /:collection/:repo/releases.atom`, `commits/:ref[/*path].atom` | Atom feeds of releases and of a history |
| `GET /:collection/:repo/issues[?state=&label=&author=&q=&sort=]` `issues/:n` | Issue list, narrowed by state, label, author, or a text search over titles and bodies, and one issue with its comments; anonymous, like every other read |
| `GET /:collection/:repo/compare[/:base...:head]` | Compare two revisions: the commits head has that base does not, and the merge-base diff between them. Also accepts `?base=&head=` from the form, and `..` for a direct diff |
| `GET /:collection/:repo/archive/:ref.{tar.gz,tgz,zip}` | Source download, streamed straight from `git archive`; the ref must be one the repository has, or a commit id |
| `GET /:collection/:repo/branches` `tags` | Ref listings (with operation forms when the session allows) |
| `GET /:collection/:repo/site/*` | Static site from the sibling `<repo>.site` directory (index.html, optional 404.html) |
| `GET /:collection/:repo/info/refs` + POST endpoints | git smart HTTP; upload-pack anonymous, receive-pack behind HTTP Basic (401 + WWW-Authenticate), push-to-create |
| `POST /:collection/:repo/info/lfs/objects/batch` | The LFS Batch API; download anonymous, upload behind push scope (401 + `LFS-Authenticate`) |
| `POST /:collection/:repo/info/lfs/objects/verify` | Post-upload integrity check; same authorization as upload |
| `GET/PUT /:collection/:repo/info/lfs/objects/:oid` | Transfer routes for the local backend only, behind an HMAC-signed `exp`/`sig` (400 when the backend is s3) |
| `/:collection/:repo/info/lfs/locks…` | Always 404; file locking is deliberately unimplemented |
| `GET /:collection/:repo/actions` | Workflow runs, the workflow filter, and the dispatch form |
| `GET /:collection/:repo/actions/runs/:n` | One run: its jobs, steps, and logs (`?job=` selects a job) |
| `GET /:collection/:repo/actions/runs/:n/log/:job` | JSON log tail from a byte offset, used by the live tailer |
| `GET /:collection/:repo/actions/runs/:n/artifacts/:name` | Download an artifact (a tar); anonymous, like every other read |
| `GET /api/whoami`, `GET/POST /api/users`, `POST /api/users/:name/grant` | Bearer-token JSON API used by the CLI |
| `GET/POST /api/runners`, `DELETE /api/runners/:name` | Runner registration; user token with admin scope |
| `POST /api/runner/acquire`, `.../jobs/:c/:r/:n/:job/{heartbeat,logs,status}`, `GET /api/runner/whoami` | The runner protocol; runner token plus a lease (3.12) |
| `PUT/GET .../jobs/:c/:r/:n/:job/artifacts[/:name]`, `POST .../site` | Artifacts and site deployment; same lease check |

UI operation routes (session + CSRF; all POSTs follow POST-redirect-GET):

| Route | Purpose | Requires |
|---|---|---|
| `GET/POST /login`, `POST /logout` | Sign in with username and token; sign out | nothing / session |
| `GET/POST /new` (optional `?collection=`) | Create a repository, optionally with an initial README | push scope over `collection/name` |
| `GET /import` (optional `?collection=`, `?src=`) | Writes the one-line command that imports an existing repository (section 3.10); performs nothing | session, push scope over the target |
| `GET/POST /:collection/:repo/edit/:branch/*path` | Edit a text file (≤ 1 MB); a changed `path` renames or moves it in the same commit, and `newBranchWanted` commits to a branch created from the same base and lands on the comparison | push scope |
| `GET/POST /:collection/:repo/new/:branch[/*dir]` | Create a file; on an empty repository this creates the branch | push scope |
| `GET/POST /:collection/:repo/upload/:branch[/*dir]` | Upload files (25 MB per commit, multipart parsed in `src/multipart.ts`), replacing what is already there and keeping its mode | push scope |
| `GET/POST /:collection/:repo/delete/:branch/*path` | Delete a file with a confirm step | push scope |
| `POST /:collection/:repo/branches/create` `branches/delete` | Branch operations (default branch is not deletable) | push scope |
| `POST /:collection/:repo/tags/create` `tags/delete` | Lightweight tag operations | push scope |
| `GET/POST /:collection/:repo/issues/new` | Open an issue | session |
| `POST /:collection/:repo/issues/:n/comment` | Comment on an issue | session |
| `POST /:collection/:repo/issues/:n/state` | Close or reopen, optionally with a comment | push scope or being the author |
| `GET/POST /:collection/:repo/issues/:n/edit` | Edit the title, body, and labels | push scope or being the author |
| `GET/POST /:collection/:repo/pulls/new` (optional `?base=`, `?head=`) | Open a pull request between two branches | session |
| `POST /:collection/:repo/pulls/:n/{comment,state}` | Comment, close, reopen | session; state needs push scope or authorship |
| `POST /:collection/:repo/pulls/:n/merge` | Merge the head into the base | push scope |
| `GET/POST /:collection/:repo/releases/new` (optional `?tag=`) | Draft or edit the notes on a tag | push scope |
| `POST /:collection/:repo/releases/delete` | Remove a release's notes; the tag is untouched | push scope |
| `GET/POST /:collection/:repo/settings` | Description and default branch | push scope (page also visible with admin) |
| `GET/POST /:collection/:repo/fork` | Fork the repository elsewhere in the vault; a bare clone, with `cofferdam.forkedFrom` recording the parent | push scope over the destination |
| `POST /:collection/:repo/settings/rename` | Rename the repository or move it to another collection, carrying its site, runs, issues, releases, and LFS objects | admin scope over the repo, and push scope over the destination |
| `POST /:collection/:repo/settings/delete` | Repository deletion after retyping `collection/repo` | admin scope over the repo |
| `GET /admin` | Administration index | admin scope |
| `GET /admin/users`, `POST /admin/users`, `POST /admin/users/:name/grant`, `POST /admin/users/:name/token` | User administration; authorization mirrors the API exactly | admin scope |
| `GET/POST /admin/appearance` | Choose the vault's theme (section 3.8) | admin scope over `*` |
| `POST /:collection/:repo/actions/dispatch` | Start a `workflow_dispatch` run | push scope |
| `POST /:collection/:repo/actions/runs/:n/{cancel,rerun}` | Cancel or re-run | push scope |
| `GET/POST /admin/runners`, `POST /admin/runners/:name/remove` | Register and remove runners (section 3.12) | admin scope |

Reserved names (never valid as collection or repo): `vault.json`, `config.json`, `runners.json`, `api`, `assets`, `login`, `logout`, `new`, `import`, `admin`, `settings`. Anything that becomes a top-level path segment the UI owns must be added here. The LFS routes added nothing, since they are sub-paths of an existing repository route rather than new top-level segments. Repo directories may be named `name` or `name.git`; the suffix is stripped for display and both resolve, which is what lets git-lfs reach the Batch API at the `.git/info/lfs` endpoint it derives on its own.

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
- Repository deletion resolves real paths and containment-checks against the vault root before any recursive removal, then removes the repo directory and its `<repo>.site` and `<repo>.runs` siblings, along with any stored LFS objects. The route also calls `engine.forgetRepo` first, so nothing is dispatched for a repository whose files are about to disappear. Any new sibling directory convention must be added here, or deleting a repository will orphan it and a repository later created under the same name will inherit it.
- Failed logins get one generic message (no username/token distinction).
- A repository's static site is called a *site*, not "pages". GitHub's name is a contraction of `github.io`, and in an interface built out of pages the word means something else in every second sentence. The feature was renamed after it was built: the directory is `<repo>.site`, the route is `/<collection>/<repo>/site/`, and the tab is Site. Migrating a vault is `mv <repo>.pages <repo>.site` per site; there is deliberately no fallback to the old directory name, since silently serving both would be a second convention to carry forever. What keeps GitHub's spelling is the compatibility surface only: the `uses:` keys `actions/configure-pages` and `actions/deploy-pages`, the `github-pages` artifact name, and the `page_url` output, because those belong to somebody else's interface. `configure-pages` exports `COFFERDAM_SITE_BASE_PATH` and also the former `COFFERDAM_PAGES_BASE_PATH`; drop the second once no workflow reads it.
- The collapsible CLI hints of the read-only era are gone entirely. Operations belong to the UI now, and a page full of `<details>` boxes explaining git commands works against that; keep new pages clean rather than reintroducing them. What remains is genuinely about the command line: the clone URL behind the Code button in the repository toolbar and the clone/push commands on the empty-repository page (as GitHub also does). Publishing a site is documented in the README rather than hinted at in the interface. The import page (3.10) is the third and last such case: an operation the server deliberately does not perform.

### 3.7 Known limitations and pitfalls for the implementer

- Admin coverage checks a requested glob as a literal target against admin globs (`mycollection/*` covers `mycollection/site` and the literal `mycollection/*`). This is sound for the common shapes but is not true glob subsumption; do not build anything that depends on exotic patterns.
- Express 4 with `'*'` wildcards and `req.params[0]` (via the `wildcard()` helper). Express 5 changes wildcard syntax; do not upgrade casually. Also: route matching is not strict about trailing slashes, which once caused a redirect loop (`/site` vs `/site/`); register more-specific wildcard routes before their prefix routes.
- Repositories imported by `git clone --bare` lack the `receive.*` protections; only push-created and UI-created repositories get `denyNonFastForwards`, `denyDeletes`, and `maxInputSize` (2 GiB).
- The collection page runs one `for-each-ref` per repo for last-update times; fine for tens of repositories, unexamined beyond that.
- Raw file serving deliberately uses `text/plain` plus a sandbox CSP for non-image types so repository content cannot inject HTML into the vault's origin. Preserve this property in anything new.
- Tokens travel as HTTP Basic passwords on push, so remote vaults need TLS in front (the compose and Fly setups provide it).
- `isValidRepoPath` rejects control characters, so files whose names contain them cannot be browsed or edited; this is a deliberate trade against the newline-delimited git plumbing formats.
- Markdown rendering is the one place where repository content becomes markup on this origin, and it rests on the sanitizer allowlist in `src/markdown.ts`. Treat changes to that allowlist as security changes, and never render a document with the sanitizer disabled.
- Rate limiting and abuse controls for public vaults are unaddressed and acceptable to defer, but say so in the README of any public deployment.
- Git LFS (3.11) carries five limitations worth stating plainly rather than leaving to be discovered. Files already committed as ordinary blobs are unaffected and stay in the packfiles; moving them requires `git lfs migrate import` on a client, which rewrites history. Tree listings show pointer sizes of roughly 130 bytes, since they come from `git ls-tree -l`; correcting this would mean reading every pointer blob in the directory, and the blob page already shows the true size. Commit diffs show pointer diffs, which is git's own behavior without the LFS diff driver. Orphaned objects leak. Object size is capped by `COFFERDAM_LFS_MAX_SIZE`, but the cap means different things per backend and the difference is worth knowing before anyone relies on it: the local PUT route enforces it on the bytes as they stream, while in bucket mode the upload never touches this process, so only the size declared in the batch request can be checked. A pusher who understates the size uploads whatever they like, and `verify` catches the mismatch only after the bytes are in the bucket, where they become orphans. Binding `content-length` into the presigned signature would close it, at the risk of refusing uploads from any client that frames the body differently; that trade was not taken here and wants a real bucket to test against. In bucket mode, treat the cap as advisory and put real limits on the bucket. The same asymmetry applies to content: the local route rejects a body that does not hash to the object id, while in bucket mode nothing verifies content, so a pusher can store arbitrary bytes under any object id within a repository they can already push to. Note that push-to-create does survive LFS, though the reason is worth recording since it is not obvious: the batch endpoint 404s for a repository that does not exist, but git fetches the remote's refs before running the pre-push hook that uploads objects, and that advertisement request is what creates the repository (3.3), so by the time the batch call arrives the repository is there. Anything that changes when repositories are created on push must keep this ordering in mind.
- Editing a pointer file through the web interface is refused in both the GET form and the POST handler. This is a correctness requirement rather than a refinement: without it, the in-browser editor lets someone commit ordinary text over a pointer and silently corrupt the repository's LFS state. Deleting a pointer file stays allowed, and the resulting orphan falls under the leak above.

### 3.8 Themes

The interface ships with a set of themes: `paper` (the default), `github`, `slate`, `midnight`, and `terminal`. Matching GitHub exactly is available but is deliberately not the default, so a cofferdam vault reads as its own thing while keeping GitHub's conventions and layout.

A theme is a record in `src/themes.ts`: a set of semantic tokens (background, surface, border, accent, tab marker, primary and danger buttons, diff colors, code and input backgrounds, three font stacks, corner radius) plus the name of the highlight.js stylesheet whose token colors suit it. `themeVarsCss()` emits them as custom properties on `:root`, prefixed by a `color-scheme` declaration so browser-native controls follow. The structural CSS in `src/style.ts` references only `var(--…)`, which is what makes adding a theme a one-entry change.

The choice is vault state, not visitor state: one vault is one interface. It lives in `<vault>/config.json` (`src/config.ts`, stat-cached like `vault.json`, hand-editable, missing or invalid values falling back to the default rather than failing requests). Because one process serves one vault, the active theme is process state that a middleware re-syncs from the config on each request, rather than a value threaded through every view; concurrent requests always agree, since the value is vault-wide. Stylesheet URLs carry the theme name as a query parameter so a change busts any cache in front of the server.

Setting the theme in the UI (`/admin/appearance`) requires admin scope covering `*`. This is stricter than the rest of user administration on purpose: an administrator delegated to one collection may manage users there, but restyling the whole vault is not theirs to do.
### 3.9 Rendered markdown

Markdown files render as documents rather than as source. `GET /:collection/:repo/blob/:ref/*path` returns rendered HTML for `.md` and `.markdown`, and `?plain=1` returns the highlighted source with line numbers, the spelling GitHub uses. A segmented Preview/Code control in the file's meta bar switches between the two, and the README box on directory pages links to the file so the source view is one click away. `src/markdown.ts` renders both, so the two views cannot drift.

The feature set targets what GitHub renders, since that is what people write their READMEs against: fenced code with highlight.js and a hover copy button, indented code blocks, tables with column alignment, task lists, footnotes, strikethrough, autolinks, emoji shortcodes, heading anchors (GitHub-style slugs, numeric suffix on duplicates, a `#` permalink on hover), alert callouts (`> [!NOTE]` and its four siblings), LaTeX math, and a subset of inline HTML. Relative links and image sources resolve against the file's own directory, with dot segments collapsed so that `../README.md` yields the path a reader would type; the rewriting happens in the sanitizer's tag transform, so links written as HTML are handled the same as links written as markdown. External links get `rel="nofollow noopener noreferrer"`.

Math is rendered on the server by KaTeX: `$…$` inline, `$$…$$` in a block, and ```` ```math ```` fences, all three as on GitHub. Invalid LaTeX renders in red rather than failing the request. KaTeX's stylesheet and fonts are served from the installed package under `/assets/katex/`, so math works on a machine with no outbound network; the font route matches names against a fixed pattern rather than joining a request path. Note that KaTeX output is verbose: a document that is mostly equations can render to twenty times its source size, which the 1 MB source cap bounds but does not make small.

Two properties are load-bearing. First, no document may put active markup on this origin. The rendered HTML passes through an allowlist sanitizer (`sanitize-html`) whose allowlist has no `style` attribute (an inline style could cover the page, which is a phishing surface even without scripting), no event handlers, no scripts, frames, or objects, and only `http`, `https`, `mailto`, and `ftp` URL schemes. This is the same property the raw-serving policy protects, and it is the reason inline HTML can be allowed at all: `<details>`, `<kbd>`, `<sub>`, alignment, and badges all work, while anything executable is discarded. Second, everything renders on the server; no page needs client-side JavaScript to read.

Those two properties conflict with the markup we generate ourselves, since highlighted code carries an inline `onclick` for its copy button and KaTeX emits MathML that the allowlist would strip. Rather than widen the allowlist, such fragments are parked in *slots*: the renderer emits an opaque marker, the sanitizer sees ordinary text, and the fragments are substituted back afterwards. The marker is random per render, so a document cannot forge one. Keep new trusted markup on that path rather than loosening the allowlist.

Mermaid diagrams are the one notable GitHub feature deliberately left out: they would need a multi-megabyte client-side bundle, which the "server renders HTML" principle rules out for now. ```` ```mermaid ```` blocks render as code, which is a reasonable fallback.

Rendered documents also carry GitHub's cross-references: `#12` becomes a link to that issue and a hex string of seven or more characters becomes a link to that commit. This happens in a core rule over the inline token stream rather than an inline rule, because by the time inline rules run markdown-it's text rule has already swallowed those characters — the same reason its own linkify works that way. Text inside a link is left alone so a reference cannot nest a second link, code spans and fences are untouched because those tokens are not text, a commit id must contain at least one letter so a plain number is not mistaken for one, and both halves are off unless the caller passes the base URLs, which keeps the rule out of contexts where a repository is not in view.

### 3.10 Importing an existing repository

Importing is a client-side operation. `git clone --bare` the source, then `git push --mirror` at a vault URL that does not exist yet; push-to-create makes the repository through `ops.createRepo`, so it arrives with the same `receive.*` protections as any other, HEAD pointed at the right branch, and branches and tags in place. `GET /import` writes that command with the collection, the target name, the vault's own host, and the signed-in username filled in, and performs nothing itself.

The clone is `--bare` rather than `--mirror` on purpose: mirroring a GitHub repository drags in `refs/pull/*`, which for a busy repository is thousands of refs the vault has no use for. A bare clone carries branches and tags, and the mirror push then moves exactly those.

We chose this over a server-side import deliberately, and the reasoning should be revisited rather than assumed. A server that clones on the operator's behalf needs outbound network access, a host allowlist and address checks against SSRF, somewhere to put credentials for private sources, a disk budget, and work that outlives a request, which is machinery this project has none of. Doing it on the operator's machine needs none of that: their existing git credentials read the source, their cofferdam token writes the vault, and progress and cancellation come from the terminal. The cost is that the data passes through their machine and that bulk import is a shell loop rather than a form. Revisit if a job model arrives for another reason, and note that `import` is a reserved name (`src/scan.ts`) reserved for exactly that possibility.

The command line is assembled from an allowlist, not a URL parse: an https or ssh git URL, or `owner/repo` shorthand for GitHub, with a character set that cannot carry spaces, quotes, or shell metacharacters. This matters more than usual, because the output is text a reader will paste into their own shell. The page also refuses targets outside the viewer's push scope and names that already exist, since both would fail at push time anyway.

### 3.11 Git LFS

A vault keeps every byte ever committed, which is fine for source code and expensive for large binary files: they grow the vault without bound and cannot be pruned without rewriting history. On a deployment with a small attached volume, a single repository holding a few large datasets can dominate the cost of the whole vault. Git LFS replaces those files in the repository with pointer files and stores the bytes elsewhere. The trade-off is latency, since fetching an object is a separate HTTP request rather than bytes already present in a packfile the client just downloaded; that is the intended trade rather than a defect.

We implement the server side of the LFS Batch API. Because the protocol lets the server return an arbitrary URL per object transfer, the s3 backend returns presigned bucket URLs and clients transfer bytes directly to and from the bucket, so large-file content never passes through this process.

**LFS adds no vault state.** Whether a blob is a pointer is determined entirely by reading the blob, so there is no per-repository flag, no marker file, and no probing on the repository page. This is deliberate: it avoids the per-request lookup `hasSite` performs in `src/web.ts`. Do not add a marker file.

Two storage backends sit behind one interface in `src/lfsstore.ts`, constructed once at startup from the environment and threaded through the `register*` functions the way `root` already is. The **s3** backend presigns SigV4 query URLs against any S3-compatible bucket (`aws4fetch`, chosen over hand-rolled SigV4 because canonical-request construction fails silently and is unpleasant to debug). The **local** backend stores objects inside the vault and issues URLs pointing back at cofferdam's own transfer routes, so LFS works in `npm run dev`, is covered by the smoke test without credentials, and remains usable on a laptop vault. Object keys and paths are identical in both (`<collection>/<repo>.lfs/<oid[0:2]>/<oid[2:4]>/<oid>`, the sharding git-lfs itself uses on the client), so moving a vault between backends is `rclone copy` and nothing else. The `.lfs` sibling follows the convention `<repo>.site` set; `listRepoDirs` filters candidates through `isBareRepo`, so such a directory is never mistaken for a repository.

Credentials come from the environment only and must never be written into `config.json` or `vault.json`: the vault is the backup unit and stays portable between deployments with different buckets. Backend selection is `COFFERDAM_LFS=off` first, then all four bucket variables present, then none present; **some but not all present is a fatal startup error** that names the missing variables, because a partially configured deployment silently storing large objects on the volume is the exact failure the feature exists to prevent. The README documents the variables and the provider matrix (R2 recommended, Tigris convenient on Fly, S3 with an explicit region).

The local backend's transfer URLs carry `exp` and `sig`, an HMAC-SHA256 over a NUL-delimited payload with an explicit `lfs` domain prefix, keyed by the same `<vault>/.secret` that signs session cookies. The domain prefix is required: it guarantees an LFS href can never be replayed as a session token. Every value that appears in the URL is inside the signed payload, so the download filename cannot be altered, and signatures are compared with `timingSafeEqual` on equal-length buffers. The PUT route streams to a temporary file and renames into place, so an interrupted upload never leaves a corrupt object at the final path, and it rejects content that does not hash to the object id in the path. That validation is available only in the local backend and is worth having where it is cheap; in the bucket configuration the verify endpoint is the only integrity check, since upload bytes bypass the server entirely.

Authorization reuses the existing model exactly: download is anonymous, matching anonymous clone (a public repository must support `git clone` followed by `git lfs pull` with no credentials), and upload goes through the same `checkPushAuth` the git receive-pack path uses, hoisted out of `registerGitHttp` for the purpose. A 401 carries `LFS-Authenticate`, the header git-lfs looks for. No new scope was added.

**Object id validation is the security boundary of `src/lfs.ts`**, playing the same role for object ids that `isValidName` plays for collection and repository names: every oid must match `/^[0-9a-f]{64}$/` before it is used to build a key or a path. `src/lfsstore.ts` re-checks the same things where they become a path or a key, so a future caller that forgets cannot escape the vault or widen a delete prefix.

Two properties of the local transfer route are load-bearing and easy to lose in a refactor. The GET route serves repository bytes from the vault's own origin, so it carries the sandbox CSP and the attachment disposition that 3.7 requires of all raw serving; without them an uploaded HTML or SVG object would be same-origin active content, reachable through an anonymous batch download. And the batch handler collapses repeated object ids to one storage lookup before fanning out: download needs no credentials, so a request repeating one id up to the 1000-object limit would otherwise multiply into that many bucket operations.

Deliberate non-goals, recorded so a later implementer does not read them as omissions: the file locking API (404 by design, which git-lfs reads as unsupported), orphan garbage collection (documented as a leak; a real collector must enumerate every pointer blob reachable from every ref across all history, which is expensive and error-prone), multipart upload (the `basic` adapter does a single PUT, hence the size cap), server-side conversion of existing files (that is `git lfs migrate import` on a client, which rewrites history), transfer adapters other than `basic`, true file sizes in tree listings, and bucket storage for sites or repository data. The storage module is meant to be reusable for that last one, but the site implementation was left alone.

Repository deletion removes stored objects too. `deleteRepo` is async for it, and the removal is best-effort: by the time it runs the repository directory is already gone and the objects are unreachable garbage, so a storage failure is logged rather than allowed to fail the deletion.

### 3.12 Workflows

A vault runs GitHub Actions workflows, and the shape of that support is a deliberate departure from how GitHub does it: **the server plans runs and never executes them**. Execution belongs to a *runner*, a `cofferdam runner run` process started by an operator on a machine with Docker. The reason is the principle in section 2 rather than convenience: one vault is one small process on one machine, and handing that process a container runtime plus the right to execute pushed code would change what a vault is. It also means a vault on a 256 MB Fly machine can host CI for repositories whose builds need far more than that.

Workflows are read from `.cofferdam/workflows/*.yml` and `.github/workflows/*.yml`. Both are collected; a file in `.cofferdam/workflows` shadows one with the same basename under `.github/workflows`, which lets a repository adapt one workflow without forking the others. The workflow language, the `github` context, and the `GITHUB_*` environment are GitHub's, unchanged, because compatibility is the point of the layer; there is deliberately no `cofferdam` alias for the context, since two names for one thing invites confusion.

**Source layout.** `src/ci/expr.ts` is the `${{ }}` language (tokenizer, parser, evaluator, `format`/`contains`/`fromJSON`/… and the `if:` semantics including the mixed-string case); it is used by *both* the server and the runner, which is why it lives in `ci/` rather than in either. `src/ci/workflow.ts` parses and normalizes a workflow file and holds the filter-pattern matcher. `src/ci/engine.ts` is the planner and scheduler: workflow discovery, matrix expansion, the `needs` graph, job conditions, concurrency groups, leases, and folding runner reports back into run state. `src/ci/runs.ts` is the on-disk format. `src/ci/runners.ts` is the runner registry. `src/ci/api.ts` and `src/ci/web.ts` are the two route modules, `src/ci/views.ts` the pages, `src/ci/present.ts` the memoized "does this repository have workflows" check behind the Actions tab. On the runner side, `src/runner/client.ts` is the poll loop and reporting, `src/runner/docker.ts` the container wrappers, `src/runner/job.ts` the step executor, and `src/runner-cli.ts` the subcommands.

**Where the boundary falls.** The server evaluates everything it can decide without watching a job run: job-level `if` (against `needs` results), `runs-on`, matrix expansion, job names, concurrency groups, `timeout-minutes`. The runner evaluates everything that depends on step outputs: step `if`, step `env`, the `run` body, step names, `continue-on-error`. This split is what lets the UI show a complete job graph before any runner exists, and what lets the server cancel or requeue without one.

**Run state** lives in `<vault>/<collection>/<repo>.runs/<n>/`, holding `run.json`, `jobs/<id>.json` per job, and `jobs/<id>.log` as newline-delimited JSON (`{s, t, l}`: step index, time, line). Matrix jobs get ids `<key>-<i>`; `needs` refers to the workflow's job key and takes the worst result across that key's members. Step index `-1` is the runner's own setup and cleanup output and is rendered as its own block, not as a step. The engine keeps an in-memory index of active runs, rebuilt from these files at startup, but the files remain the durable state; a restart resumes queued runs and, once their leases expire, requeues jobs that were running.

**The runner protocol** is plain HTTP JSON with a long poll (25 s), so a runner needs no inbound connectivity and works through any proxy that passes ordinary requests. `POST /api/runner/acquire` returns a `JobSpec` (the shared type in `src/ci/protocol.ts`) or 204; the job-scoped endpoints (`heartbeat`, `logs`, `status`) are authorized by the runner token *and* by an `X-Cofferdam-Lease` header carrying the lease minted at acquire, so a runner can only touch the job it currently holds. Leases last 90 s and are renewed by heartbeats and log posts; the engine sweeps expired ones every 30 s and requeues, failing the job after three attempts.

One pitfall is recorded because it cost a debugging session and would recur: the acquire handler must detect a disconnected runner by listening on `res`, not `req`. A request whose body has been fully read emits `close` on `req` immediately, long before the client goes away, so `req.on('close')` cancelled every job at the moment it was leased.

**Runners are not users.** They live in `<vault>/runners.json` with a hashed token, a label list, and an `allow` list of globs over `collection/repo`. A runner token is rejected by every user endpoint and a user token by every runner endpoint; the two credential presentations stay distinct, as git's and the API's do (3.4). An empty `allow` list means nothing rather than everything. Registering a runner requires admin scope over exactly the globs granted, and the reason is worth stating plainly in any UI that grows around this: a runner executes repository-controlled code on the machine it runs on, so `--allow` is a grant of that machine to those repositories. Docker is a guard against accidents, not against a hostile workflow.

**Execution.** One container per job, started with a sleeping entrypoint, with steps run through `docker exec`, matching how container jobs behave on GitHub: steps share a filesystem and anything one installs is there for the next. Three host directories are bind-mounted: the workspace, `RUNNER_TEMP`, and a directory for the file commands. The runner clones the repository into the workspace *before* the job starts, which is a deliberate divergence from GitHub's empty workspace (see the note in the README); it makes `run:` steps useful before action support exists and means `actions/checkout` becomes a re-sync rather than the first clone when actions land. `runs-on` labels map to images through a table the operator can override.

**Actions.** A `uses:` step resolves to one of three things. A JavaScript action (`node16`/`node20`/`node24`) is fetched as a source tarball from github.com, cached under `~/.cache/cofferdam/actions`, copied into the job's own directory, and run with a node interpreter; its `pre` and `post` scripts become hooks, and post hooks run in reverse order after the job's steps, whatever the job's outcome. A composite action is expanded natively: `runSteps` recurses with a fresh scope, so a composite's `steps` context, its `inputs`, and its `GITHUB_ACTION_PATH` are its own, and nesting works to a depth limit of 10. A docker action fails with a message.

The pristine download is never what the container sees: the action is copied into the job's directory first, so an action that writes into its own directory cannot poison the next job's copy. Cache entries are keyed by the commit the ref resolves to, found with a `git ls-remote` before the download, so an entry cannot be stale: a moved branch produces a different key and a fresh download, an unchanged one is reused forever, and the entry the ref pointed at previously is pruned, which keeps the cache at one copy per ref as it was when keys were names. A resolution is remembered for the length of a job, so a job whose steps all use the same action asks the forge once and nothing carries into the next job. A forge that cannot answer `ls-remote` (no network, a private repository, a host that serves tarballs but not git) falls back to the older rule, keying by name and re-fetching after a day, and logs why. Every resolve logs the commit and whether the copy came from the cache: a run that quietly used a day-old action is otherwise indistinguishable from one that used the tip, which was the trap worth closing. `--no-action-cache` (or `COFFERDAM_ACTIONS_NO_CACHE=1`) downloads every time.

JavaScript actions need node inside the container. If the image has a new enough one, it is used; otherwise the runner downloads an official build once and bind-mounts it read-only at `/cofferdam/externals`, which is how GitHub's own runner makes `actions/checkout` work on an image with no node. Those builds are glibc-linked, so a musl image gets an explicit message rather than a loader error.

**Overrides** (`src/runner/overrides.ts`) substitute cofferdam's own implementation for actions that are clients of GitHub-only services: `actions/checkout`, `upload-artifact`, `download-artifact`, `configure-pages`, and `deploy-pages`. They are matched on `owner/repo` ignoring the ref, and applied at any nesting depth, which is what makes one inside a third-party composite action work. Note that `upload-pages-artifact` is deliberately *not* overridden: it is an ordinary composite that tars a directory and calls `upload-artifact`, so the real action runs on top of cofferdam's override, and the same will be true of anything else built that way. Substituting by name rather than implementing the artifact v4 twirp protocol and an OIDC issuer is perhaps a tenth of the work; the cost is following a handful of action interfaces as they change.

One thing to keep in mind when touching the overrides: a path in a workflow or an action is written as the *container* sees it, while an override works on the host side of the bind mounts. `StepExecContext.hostPath` does that translation, and forgetting it is why `upload-pages-artifact` (which passes `${{ runner.temp }}/artifact.tar`) failed the first time.

**Artifacts** are tars under `<repo>.runs/<n>/artifacts/<name>.tar`, so they are pruned with their run and copied with a vault backup. Writing one is authorized by the job's lease, so only a running job can, and only into its own run. Reading is anonymous on the web, like every other read in a vault. `deploySite` in `src/ci/artifacts.ts` publishes one as `<repo>.site`: extraction happens on the server because the site directory is vault state, and the archive is treated as untrusted, extracted into a scratch directory, checked for symlinks pointing out of it, and swapped in by rename so a half-extracted archive is never the live site.

**What is still not implemented, and how it fails.** Reusable workflows, `container:` jobs, and `services:` fail at plan time with a message; a dynamic (expression) matrix and docker actions fail at the step. All fail loudly rather than skipping, because a build step that silently did nothing and reported success is the worst possible outcome. Absent: secrets, `actions/cache` and the cache service, `hashFiles()`, a token for the run, and the object-filter (`*`) expression syntax. Note that an action which calls a forge API gets an empty `github.token`; `actions/setup-node` handles that by falling back to nodejs.org, but not everything will. `::add-mask::` masking *is* implemented despite the absence of secrets, since steps derive tokens at runtime.

A site is served at `/<collection>/<repo>/site/` while GitHub serves one at `<owner>.github.io/<repo>/`. `configure-pages` reports the real base path and exports `COFFERDAM_SITE_BASE_PATH` (and, for now, `COFFERDAM_PAGES_BASE_PATH` under its former name), so a generator that reads it is correct; one that computes its own from the repository name produces GitHub's shape and broken links, and needs the base passed explicitly. The numbl workflow this feature was built against happens to emit relative URLs, so it is unaffected; do not read that as the general case.

### 3.13 Issues

Issues live in a sibling directory, `<repo>.issues/`, beside the `.git`, `.site`, and `.runs` directories. The open question in the previous specification was this one or a hidden git ref inside the repository; the sibling directory won for the same reason the rest of the vault has that shape, that what is on disk stays legible without the server, greppable, editable in an editor, and backed up by copying a directory. The cost is that issues do not travel with a clone, which a later export can address.

One directory per issue: `<repo>.issues/<n>/issue.md` is the issue as markdown under a YAML frontmatter header (`title`, `state`, `author`, `created`, `updated`, `labels`, and `closedBy`/`closedAt` once closed), and `<repo>.issues/<n>/comments/<id>.md` is each comment, the same shape with `author` and `created`. A comment is a separate file so that writing one never rewrites the issue and two people commenting at once cannot lose each other's words. Numbers are allocated by `mkdir`, which the filesystem makes atomic: whoever creates the directory owns the number and a writer that loses the race takes the next one. Every write lands beside its target and is renamed into place.

Authorization follows the vault's model rather than GitHub's. Reading is anonymous, like every other read. Opening an issue and commenting need a session — a vault's users are its users, and there is no public sign-up to abuse. Closing, reopening, and editing need push scope over the repository or being the author. Labels are a push-scope decision, so a form that carries them from someone without it is read without them. Every mutating route checks CSRF and re-derives abilities from live `vault.json`, like the rest of the operations layer, and issue and comment bodies are rendered by the same sanitizing markdown pipeline as a README (3.9), which is what keeps one user's issue from carrying script into another user's session.

Labels have no registry: the set of labels is whatever the issues carry, and a label's colour is derived from its name the way an identicon is, so nothing has to be stored for one to look the same on every page. The list is narrowed by state, label, author, and a text search; the search matches titles, bodies, and labels while the files are being read, since that is where the body is already in hand.

Counting open issues means reading every issue's header, and the Issues tab asks for that count on every page of a repository, so the count is memoized against the issues directory's modification time and every write touches that directory. A repository with no issues never pays for the tab.

### 3.14 Pull requests

A pull request is one branch proposed into another of the same repository, stored the way issues are: `<repo>.pulls/<n>/pull.md` with a YAML frontmatter header, `<repo>.pulls/<n>/comments/<id>.md` for each comment, numbers allocated by `mkdir`, and every write landed beside its target and renamed into place. The header carries `base` and `head` and, once it is over, `mergedBy`/`mergedAt`/`mergeSha` or `closedBy`/`closedAt`. The store deliberately mirrors `src/issues.ts` rather than sharing it; if a third thread-shaped thing ever appears, the common half is worth extracting then.

Nothing about the diff, the commits, or the mergeability is stored. Those are questions for git, which can answer them from `base` and `head` at any moment, and a stored copy would only ever be a stale one.

Merging happens in the bare repository, with no work tree and no clone. `git merge-tree --write-tree` computes the merged tree in the object database and names the paths that conflict; a clean result is committed with `commit-tree` against exactly that tree, so the merge a reader was shown is the merge that happens, and the branch moves with a guarded `update-ref` whose old value is the tip the merge was planned against — a branch that moved while the reader was deciding fails the merge rather than losing the commit that moved it. A merge commit is always made, even where the base could simply advance, because that commit is the record of the decision; squashing is the other offered method, and it commits the same tree with the base as its only parent, which is what makes the branch's own history disappear from the base. A merged pull request can then have its head branch deleted from the page, for any branch but the one it was merged into. Conflicts are reported and never committed: resolving them needs a work tree and a person, and the vault has neither. A merge moves a branch, so it fires the same push event to the CI engine that an edit in the browser does (3.12).

Authorization: reading is anonymous, opening one and commenting need a session, closing and reopening need push scope or authorship, and merging needs push scope over the repository, because it writes to a branch like any other write. Bodies and comments go through the same sanitizing markdown pipeline as a README (3.9).

Across repositories is the open question. Nothing in the stored shape forbids it — a head could name another repository — but a vault has no way to name one yet.

### 3.15 The shape of the interface

The interface keeps the arrangement its readers already know: a repository has tabs across the top, a directory listing carries the last commit, a pull request has a merge box. What is drawn on that arrangement is the vault's own. The conventions below carry most of it and should be kept when new pages are added.

The drawing is set out at the top of `src/style.ts` and comes to this. A section of a page is a 2px rule the width of the column, a caption under it, and the content inset by 12 pixels below that, rather than a bordered panel with a filled strip across its top. A border on all four sides means the reader can operate the thing: a button, an input, a menu, a list item that is itself a link. Fills are for code, which needs an edge of its own. Anything carrying news rather than structure, a merge state or a flash or an error, takes a 3px rule down its left side in the colour of what it says. Nothing is a stadium; a badge is a rectangle with the corner radius a button has. The active tab is marked with the square from the logo's mark, and the same square is the bullet in the language list, so the mark, the icons, and the page are one drawing rather than three.

Three colours carry state and mean the same thing wherever they appear: the vault's accent for what is open and current, the green a passing run uses for what landed, and the muted grey for what is over. An open issue is therefore drawn in whatever colour the vault chose for itself, which is the point of a theme being a property of the vault (3.8).

- **Icons are drawn here**, in `src/icons.ts`, and reached through `icon(name)`. They are monoline: a 2-unit stroke on a 24-unit grid with round caps and joins, no fills except where a shape has to read as solid at 16 pixels. That is the construction the logo uses, so the interface and the mark are one drawing rather than two, and it is what keeps the set from being a copy of somebody else's. They are decorative beside a label and so are `aria-hidden`; an icon-only control labels itself. Adding one means drawing it in that file, not adding a dependency: cofferdam ships no static files.
- **Times are ages.** `timeTag()` from `src/render.ts` renders "3 minutes ago" with the exact time in `title` and the ISO timestamp in `datetime`. Rendering is server-side, so the age is computed at render time and does not tick; that is the trade for having no client framework. Prefer it to `formatDate()` anywhere a reader is asking "when did this happen" rather than reading a log.
- **Menus are `<details>` elements** with the `dropdown` class: the summary is a button, the body is `.dropdown-menu`. The page script closes them on an outside click or Escape and filters long ones (`filterMenu`). The branch picker, the Code button, and the workflow dispatch form are all the same control.
- **A file view is one element per line**, each with an `id` of `L<n>` and an anchor to it, so a reader can link to a line and the linked line is highlighted. Splitting highlighted code into lines is `highlightedLines()` in `src/render.ts`, which closes and reopens the spans highlight.js runs across line boundaries; it takes highlight.js output specifically and is not a general HTML splitter.
- **A directory listing carries the last commit** for every entry: message and age, as on GitHub. That is one `git log -1` per entry (`GitRepo.lastCommits`), capped at 250 entries per page so an unusually wide directory degrades to a plain listing instead of a slow page.
- **The file finder is the way people navigate a repository they know.** `/{collection}/{repo}/find/{ref}` renders every path at that ref and filters it in the browser by subsequence match, the t key reaches it, and Enter opens the first match. No search endpoint and no index: the trade is a page proportional to the tree, capped at 20,000 paths.
- **Every name has a face.** `avatar()` in `src/avatar.ts` draws a GitHub-style identicon from a hash of the name: a 5 x 5 mirrored grid in one hue. No picture is uploaded and none is fetched from a third party, which is the point; a vault should not phone home to render a page.
- **The repository root has an About panel** on the right, with the description, the documents a reader looks for (readme, license, site), and the commit, branch, and tag counts. It appears at the root only, as GitHub's does.
- **A repository says what it is written in.** `languageBreakdown()` in `src/languages.ts` measures the tree at a ref by extension, using the blob sizes `git ls-tree -l` already reports, so the bar costs one command and no blob reads. It follows Linguist in counting only programming and markup, which is why a repository of markdown and JSON reports no languages rather than reporting itself as Markdown; vendored and generated paths are skipped by a documented subset of Linguist's rules, sizes are of the blob as stored (an LFS pointer is 130 bytes), and a tree wider than 20,000 files is not measured at all. The colours are Linguist's and are the one place the interface names a colour outside `themes.ts`, because a language's colour belongs to the language: they are inline on the bar, from the table in that file and never from anything a repository contains.

## 4. Later phases, sketched

- **Pull requests across repositories.** Branch-to-branch within one repository is implemented (3.14). A pull request from a fork waits on a way to name a head that lives in another repository of the same vault, which is a question of stored shape rather than of the merge itself.
- **Secrets and a run token.** Neither exists yet. A run token minted per job from the workflow's `permissions:` block, revoked when the job ends, is what would let a workflow push back to its own repository and call the vault's API; it is also what would stop actions that expect `github.token` from reporting "Bad credentials" and taking a fallback path. Secrets storage was deliberately deferred rather than designed badly: whether a vault backup should carry live secrets is unresolved (7.11).
- **A cache service**, so `actions/cache` and the caching built into `setup-node` and its relatives stop being no-ops. A runner-local directory is the obvious first implementation, with the trade-off that a second runner starts cold.
- **JSON everywhere.** Content negotiation on the read routes, the ops layer exposed through the API for CLI parity, `--json` on the CLI, and a raw `cofferdam api` passthrough command.
- **Published container images and CI for cofferdam itself**, once the project is hosted somewhere with CI.

## 5. Security notes for the next implementer

Escaping is manual (`esc()` in views); every new interpolation into HTML must go through it, and command arguments must keep using `execFile` arrays, never a shell. Validate every collection/repo/ref/path from a URL or form with the existing validators before it reaches git; ref names additionally must not start with `-`. LFS object ids are the same kind of boundary and get the same treatment (3.11): validate against `/^[0-9a-f]{64}$/` before building any key or path from one, and keep the `lfs` domain prefix on transfer signatures, since `.secret` also signs session cookies. The raw-serving content-type policy (3.7) must survive any refactor. So must the markdown sanitizer (3.9): rendered documents are attacker-controlled markup on the site's origin, and an escape there hands a repository writer any reader's session. Session cookies must never be accepted for the git or Bearer API endpoints, and tokens never grant UI sessions implicitly; the two credential presentations stay distinct. Deletion paths (`deleteRepo`) must resolve and containment-check against the vault root before any recursive removal. Every mutating route re-derives abilities from live `vault.json` and checks CSRF; keep both properties when adding routes.

Workflows (3.12) add a category of risk the rest of the system does not have, because they execute repository-controlled code. Three properties hold it together and must survive any change. Jobs never run in the server process or on its machine. A runner's `allow` list is the whole of its authority, an empty one grants nothing, and registering a runner demands admin scope over exactly the globs granted, since the grant is really a grant of that machine. And the job-scoped runner endpoints check the per-job lease in addition to the runner token, so a runner allowed to serve a collection still cannot write to a job it does not hold. Note also that `::add-mask::` masking runs on the runner before lines are shipped, so an unmasked value never reaches the vault; keep it there rather than moving it server-side.

Two further boundaries came with artifacts (3.12). Artifact names become filenames and are validated like job ids. And `deploySite` extracts an archive a runner supplied into vault state: it must keep extracting into a scratch directory, removing symlinks that point out of it, and swapping in by rename, so that neither a crafted archive nor a failure part-way through can write outside the site or leave a broken one live.

## 6. Housekeeping

The verification style is `scripts/smoke.sh` plus manual curl and git against the example vault; extend the smoke test with each new feature, since it is the only automated check. The CI checks there follow the pattern the LFS checks established: everything that does not need Docker runs always, and the job-execution checks skip with a message when `docker` is absent (`SMOKE_CI_IMAGE` picks the image; it defaults to `ubuntu:24.04` because it is small, at the cost of containing almost no tooling). The dev loop is `npm run dev` against `example-root`; regenerate it any time with `rm -rf example-root && npm run example` (the example vault's `vault.json`, with its fixed dev token, is recreated by the script). `npm link` is set up for the `cofferdam` binary. Self-hosting the project in a vault would be fitting once a public vault exists.

## 7. Open questions

1. Web identity beyond tokens: per-user passwords, or OIDC per vault, or nothing more?
2. Real names and emails for commit authorship (a `displayName`/`email` field on user records?), versus the current `username@noreply.<host>` placeholder.
3. Pull request storage. Issues answered half of this question in 3.13, and answered it for releases too: a sibling directory, not an in-repo ref. What is left is whether a pull request is an issue carrying a base and a head, or a record of its own kind, and whether it shares `<repo>.issues/` or gets a directory beside it. Whether an issue's number survives a repository rename or transfer is still open, and belongs with 6.
4. Session revocation granularity: is rotate-the-secret acceptable, or do sessions need server-side state eventually?
5. Multi-tenant hosting (a vault per account on shared infrastructure) as a product, versus staying purely self-hosted.
6. Repository renames and transfers, which interact with issue IDs, site directories, and clone URLs.
7. Whether `receive.maxInputSize` and the `deny*` configs should be applied retroactively to imported repositories by a vault-check command.
8. User deletion and token revocation in the UI (today the escape hatch is hand-editing `vault.json`).
9. Whether a visitor should be able to override the vault's theme for themselves (a cookie, or following `prefers-color-scheme` when the vault picks a light theme), versus the current position that the theme belongs to the vault.
10. Whether a vault should ever import server-side (section 3.10), which is the same question as whether it grows a background-job model. Note that 3.12 answers a neighboring question in the negative: work that runs code goes to a runner, not to the server.
11. Where workflow secrets live. A file in the vault is consistent with everything else but puts live secrets in the backup unit; encrypting them under a key from the environment keeps a copied vault inert but adds deployment state that must be backed up separately or the secrets are lost. Deferred rather than decided.
12. Whether runners should report themselves (last seen, current job) and where that would live, given that `runners.json` is static registration and per-process liveness is not vault state.
