# hubbit

Hosting git repositories usually means running a service with a database (GitHub, GitLab, Gitea). A limitation of that approach is that the state of the system lives somewhere you cannot see directly. Here we take a simpler route: the filesystem is the database. You have a directory we call a vault, each subdirectory of the vault is a collection, and each subdirectory of a collection is a bare git repository. Point the server at the vault and you get a GitHub-style web interface for browsing and operating on the repositories, anonymous clone access over HTTP, and token-authenticated push.

```
<vault>/
  vault.json              (users and hashed tokens; created on first start)
  .secret                 (session-cookie signing key; created on first need)
  runners.json            (registered workflow runners; created when you add one)
  alice/
    hello-numerics.git/   (bare repository)
    hello-numerics.runs/  (its workflow runs and logs)
    webapp.git/
    webapp.site/          (static site for webapp)
    webapp.issues/        (its issues, one directory each)
    webapp.releases/      (its release notes, one file per tag)
    webapp.releases/      (its release notes, one file per tag)
    webapp.lfs/           (its Git LFS objects, when no bucket is configured)
  bob/
    notes.git/
```

The `.git` suffix on repository directory names is optional; it is stripped for display either way.

## Features

- Collection and repository listings
- A GitHub-shaped interface: a branch and tag picker, a Code menu with the clone URL, directory listings that show each entry's last commit and how long ago it landed, an About panel, and times written as ages
- File browsing at any branch or tag, with syntax highlighting and linkable line numbers
- Markdown files rendered as documents, with a Preview/Code toggle (`?plain=1` for the source, as on GitHub); READMEs shown on directory pages
- The GitHub markdown feature set: highlighted code with a copy button, LaTeX math through KaTeX (`$…$`, `$$…$$`, and ```` ```math ```` blocks), tables, task lists, footnotes, alert callouts (`> [!NOTE]`), emoji shortcodes, heading anchors, and a sanitized subset of inline HTML
- Commit history with pagination, and diff views that number both sides of every hunk, count what each file gained and lost, and fold away a file you have read; the History button on any file or directory narrows it to that path
- Search the files at any ref for a literal string, with the matches grouped by file, and a file finder (`Go to file`, or the `t` key) that filters every path in the tree as you type
- Blame: every line beside the commit that last touched it, and a step back to the blame before that change
- Contributors in the About panel, each leading to their commits; any history can be narrowed to one author
- Releases: notes attached to a tag, stored in the vault beside the repository, with the source archives as their downloads
- Atom feeds for a repository's releases and for any history (`/commits/<ref>.atom`, narrowed by path like the page it follows)
- Comparing two revisions: what one branch has that another does not, and the diff between them, from the Compare button on any branch or tag
- Issues: open, comment, label, close, and reopen, stored as markdown files in the vault
- Cross-references in any rendered markdown: `#12` links to that issue and a commit id links to that commit, as on GitHub
- Source downloads: `.tar.gz` or `.zip` of any branch, tag, or commit, from the Code button or straight from `/<collection>/<repo>/archive/<ref>.zip`
- A language breakdown in the About panel: the share of the source each language holds, drawn as GitHub's bar in Linguist's colours
- Sign-in with username and token; operations happen directly in the web interface:
  - creating repositories (with an optional initial README)
  - editing, creating, and deleting files, committed straight to a branch
  - creating and deleting branches and tags
  - repository settings: description, default branch, and deletion
  - user administration: creating users, granting scopes, minting tokens
  - a choice of themes for the vault (see below)
- Anonymous `git clone http://host:port/collection/repo` over smart HTTP
- Authenticated `git push`, including push-to-create for new repositories
- Git LFS, with objects in an S3-compatible bucket or inside the vault (see below)
- GitHub Actions workflows from `.hubbit/workflows` or `.github/workflows`, planned by the server and executed by a runner you start elsewhere with Docker (see below), with live logs in the interface, JavaScript and composite actions, artifacts, and deployment to a repository's site
- A JSON API and a `hubbit` CLI for user management, including `hubbit login` to hand the token to git so pushing stops asking for it
- Per-repository static sites served from a sibling `<repo>.site` directory

There is no database and no build step for the frontend: all state lives in the vault directory, and the server renders plain HTML.

## Quick start

```bash
npm install
npm run example    # creates example-root/ with sample collections, repositories, and a dev user
npm run dev        # serves example-root/ at http://127.0.0.1:3000
```

The example vault includes a user `dev` with the fixed token `hubbit_example_dev_token` (full push and admin scope, example vault only). Sign in with it on the web interface to see the operational controls.

To serve your own vault:

```bash
npm run build
node dist/index.js serve /path/to/vault --port 3000
```

On the first start with no `vault.json`, the server initializes one and prints an owner token once; save it, since only its hash is stored.

To check the whole system end to end (browsing, sessions, UI operations, the API, git over HTTP):

```bash
npm run smoke
```

## Signing in on the web

Users sign in with their username and an existing token, the same credential git uses for pushing; there are no passwords and no separate web credential. The server sets a signed, stateless session cookie (30 days, `HttpOnly`, `SameSite=Lax`, `Secure` over HTTPS). The signing key lives in `<vault>/.secret`; rotating that file invalidates every session at once, and permissions are re-derived from `vault.json` on every request, so removing a user's tokens cuts off their sessions immediately.

Abilities in the interface mirror the token model exactly. Push scope over a repository enables creating it, editing files, and managing branches and tags; admin scope enables user management and repository deletion. Signing in with a restricted (token-scoped) token carries that restriction into the session, and such sessions have no admin rights. Controls a user cannot use are simply not shown.

File edits use optimistic concurrency: the edit form records the commit it was loaded against, and if the branch moves before you commit, the edit is refused with a conflict page rather than clobbering the other change. Web commits are authored as `<username> <username@noreply.<host>>`.

One deliberate asymmetry: repositories created by push set `receive.denyDeletes`, so `git push --delete` is refused, while the web interface allows branch deletion after confirmation. The receive hook guards against accidents; a confirmed click is explicit intent.

## Themes

The interface ships with a small set of themes, chosen under **Admin > Appearance**:

| Theme | Look |
|---|---|
| `paper` | Warm off-white with teal links and serif headings. The default. |
| `github` | The familiar light gray and blue, for people who want no surprises. |
| `slate` | Cool gray surfaces with an indigo accent. |
| `midnight` | A dark theme with azure links, for low light. |
| `terminal` | Near-black, phosphor green, monospace throughout. |

A theme is a property of the vault rather than of the visitor: one vault is one interface, and the operator picks how it looks. The choice lives in `<vault>/config.json`, so it can equally be set by hand before the first start, and the server picks up an edit without a restart:

```json
{ "theme": "midnight" }
```

Changing it in the UI requires admin scope over the whole vault (`*`); an administrator delegated to one collection can manage users there but cannot restyle the site. An unknown theme name falls back to the default rather than failing requests, so a typo in `config.json` cannot take the vault down.

Each theme is a set of semantic CSS custom properties (background, surface, border, accent, diff colors, fonts, corner radius) plus the highlight.js palette that suits it. The structural stylesheet in `src/style.ts` names no colors of its own, so adding a theme means adding one entry to `src/themes.ts`.

## The hubbit command

Everything is available as `node dist/index.js <command>` after `npm run build`. To get a `hubbit` command on your PATH instead, link the package from a checkout:

```bash
npm run build
npm link          # then: hubbit --help
```

Use `npm unlink -g hubbit` to remove it. Note that with a version manager such as fnm or nvm the link belongs to the active Node version, so switching versions hides it until you link again.

`hubbit serve` is the only command that touches the vault directory (set it positionally or with `HUBBIT_VAULT`). Every other command talks to a running server, so it works the same whether the vault is on your machine or across the network:

```bash
export HUBBIT_HOST=http://127.0.0.1:3000
export HUBBIT_TOKEN=<a token with admin scope>
hubbit whoami
hubbit user list
```

`hubbit login` and `hubbit logout` are the exception to that: they call the server once to check who the token belongs to, then write to git's credential store on the machine they run on (see [Not typing the token every time](#not-typing-the-token-every-time)). `hubbit runner run` is the other exception, and the larger one: it is a long-running process that takes workflow jobs from a vault and executes them locally in Docker (see [Workflows](#workflows)).

`--host <url>` and `--token <t>` override the environment per command. By default the server binds 127.0.0.1. Use `--host 0.0.0.0` on `serve` to expose it on the network; note that this exposes read access to every repository in the vault, and that tokens then travel over plain HTTP unless you put TLS in front. The first line of the `description` file inside a bare repository is shown in listings, as with classic git hosting.

## Pushing

The first token comes from the server's first start (the printed owner token). With that you can create users on the web (Admin, in the header) or over the API:

```bash
hubbit user add jeremy
```

This creates the user in `<vault>/vault.json` on the server and prints the token once; only its SHA-256 hash is stored. Then push with the username and the token as the password:

```bash
git push http://127.0.0.1:3000/mycollection/myrepo main
# git prompts: username 'jeremy', password '<token>'
```

Pushing to a repository that does not exist yet creates it, provided the target matches your scope; the collection directory is created as needed, and after the first push HEAD points at the pushed branch. Repositories created this way get `receive.denyNonFastForwards`, `receive.denyDeletes`, and a `receive.maxInputSize` limit of 2 GiB. Anonymous fetch stays open; only pushes require authentication.

### Not typing the token every time

Being asked for the token on every push is the wrong default for a vault you use daily. A token is the password git sends over Basic auth, so the place to keep it is git's own credential store, which `git clone`, `git fetch`, `git push`, and `git lfs` all consult through the same plumbing. `hubbit login` puts it there:

```bash
export HUBBIT_HOST=https://vault.example.com
hubbit login --helper store        # asks for the token, without echo
```

Afterwards nothing about this vault prompts again. `hubbit logout` removes the credential.

`--helper` says where the token lives, and is recorded for this vault's host alone, so other remotes keep whatever they already use:

| Helper | Where the token goes |
| --- | --- |
| `store` | `~/.git-credentials`, mode 0600, in plain text, the same posture as a GitHub token |
| `cache` | memory only, forgotten after 15 minutes |
| `libsecret` | the desktop keyring, on Linux |
| `osxkeychain` | the login keychain, on macOS |

Pass `--helper` once; later runs of `hubbit login` reuse whatever is already configured for the host. If nothing is, the command refuses rather than reporting success, because `git credential approve` with no helper configured stores nothing and still exits zero. The token is checked against `/api/whoami` before being stored, so a mistyped one fails immediately rather than at the next push, and it is read back afterwards, which is what catches a helper that is configured but not installed.

Note that this is a client-side arrangement: the vault has no notion of a login, holds no session for git, and is unaware that a credential was stored. Revoking access is still a matter of removing the token from `vault.json`.

If you already export `HUBBIT_TOKEN` for the CLI, a credential helper reading it directly is a reasonable alternative, and keeps the token out of any file git writes:

```bash
git config --global 'credential.https://vault.example.com.helper' \
  '!f(){ echo username=jeremy; echo "password=$HUBBIT_TOKEN"; }; f'
```

The trade-off is that this works only where the variable is exported, so editors, GUI git clients, and cron jobs see no credential at all.

### Importing an existing repository

Importing runs on your machine, not on the server. Sign in, open **Import** on any collection page (or go to `/import`), give it a GitHub URL or `owner/repo`, and the page writes the exact command:

```bash
tmp="$(mktemp -d /tmp/import.XXXXXX)" && \
  git clone --bare https://github.com/owner/repo.git "$tmp" && \
  GIT_ASKPASS= git -C "$tmp" push --mirror https://you@vault.example.com/mycollection/repo && \
  rm -rf "$tmp"
```

The clone is a scratch copy, so it goes to a temporary directory rather than to whatever directory you happen to be standing in, and a fresh one each time means a failed attempt never blocks the next.

If you have run `hubbit login`, the push takes the token from git's credential store and asks nothing. Otherwise git asks for a password on the push: that is your hubbit token. The `GIT_ASKPASS=` prefix keeps that prompt in the terminal you pasted the command into. Without it, an editor that sets `GIT_ASKPASS` for its integrated terminal, as VS Code does, answers the prompt with a dialog box elsewhere in the window instead; if that dialog goes unnoticed, git prints nothing after the clone and waits, which reads as a hang. The push creates the repository, so the target must not exist yet, and your push scope has to cover it. Branches and tags come across. Issues and pull requests do not, and the description is set afterwards in repository settings.

If the repository uses Git LFS, the mirror push carries the pointer files but not the objects behind them, and the imported files will show as missing until you bring those over too. Do it from inside the bare clone, before deleting it:

```bash
tmp="$(mktemp -d /tmp/import.XXXXXX)"
git clone --bare https://github.com/owner/repo.git "$tmp"
GIT_ASKPASS= git -C "$tmp" push --mirror https://you@vault.example.com/mycollection/repo
git -C "$tmp" lfs fetch --all https://github.com/owner/repo.git
GIT_ASKPASS= git -C "$tmp" lfs push --all https://you@vault.example.com/mycollection/repo
rm -rf "$tmp"
```

`--all` copies every version of every tracked file rather than only the tips, so the history stays checkoutable.

The clone is `--bare` rather than `--mirror` on purpose: mirroring a GitHub repository also copies `refs/pull/*`, which can be thousands of refs.

### Users, tokens, and scopes

`vault.json` holds a `users` object. Each user has a list of hashed tokens, a list of push scope globs, and a list of admin scope globs, all matched against `collection/repo`, where `*` matches any characters including `/`:

```json
{
  "users": {
    "owner": { "scope": ["*"], "admin": ["*"], "tokens": [{ "hash": "..." }] },
    "ci": { "scope": ["mycollection/*"], "admin": [], "tokens": [{ "hash": "...", "scope": ["mycollection/site"] }] }
  }
}
```

`scope` says where the user may push (and, on the web, create repositories and edit files). `admin` says where the user may manage other users and delete repositories: an owner has `admin: ["*"]`, while `admin: ["mycollection/*"]` lets a user hand out push access within `mycollection` but nowhere else. A token may carry its own scope, which is intersected with the user scope; this is useful for minting a narrowly scoped token (`--token-scope`) without changing the user. Such restricted tokens carry no admin rights at all. New users default to push scope `["*"]` and no admin scope. The server re-reads the file when it changes; hand-editing it remains possible and is the escape hatch for locked-out vaults. If the file cannot be parsed, writes refuse until it is fixed, while read access continues to work.

### Granting access to a collection or repository

Permission is granted by adding scope globs to a user, using an actor whose admin scope covers the globs being granted. On the web this is the Grant form on the users page; over the CLI:

```bash
hubbit user add alice --scope 'mycollection/*'      # create with access to one collection
hubbit user grant alice --scope 'othercollection/*' # extend an existing user
hubbit user grant alice --admin 'mycollection/*'    # delegate user management for mycollection
hubbit user list                                    # review who can push where
```

Note that `--scope` on `hubbit user add` applies only when creating a user; on an existing user the command refuses rather than silently replacing their permissions (run it without `--scope` to mint an additional token).

### JSON API

The CLI is a thin client over a small API, authenticated with `Authorization: Bearer <token>`:

```
GET  /api/whoami                user, scopes, and restriction of the presented token
GET  /api/users                 list users (admin required)
POST /api/users                 create a user or mint a token  {username, scope?, admin?, tokenScope?}
POST /api/users/:name/grant     extend a user's scopes         {scope?, admin?}
```

The API accepts only bearer tokens and git accepts only Basic auth; session cookies never authorize either. The two credential presentations stay deliberately distinct.

## Issues

Every repository has an issue tracker at `/<collection>/<repo>/issues`. Reading issues is anonymous, like everything else here; opening one and commenting need a signed-in user, and closing, reopening, or editing needs push access or being the person who wrote it. Bodies are markdown, rendered by the same pipeline as a README.

They are files, not rows:

```
alice/
  webapp.issues/
    1/
      issue.md          (YAML frontmatter: title, state, author, created, updated, labels)
      comments/
        1.md            (frontmatter: author, created)
        2.md
    2/
      issue.md
```

So an issue can be read, written, grepped, and backed up without the server. Editing one by hand is fine: the server reads what is on disk on every request. A comment is its own file, so two people commenting at the same moment cannot overwrite each other, and issue numbers are handed out by `mkdir`, which the filesystem makes atomic.

## Sites

A repository can have a static site, served at `/<collection>/<repo>/site/`. The content is plain files in a sibling directory next to the bare repository:

```
<root>/alice/
  webapp.git/     (the repository)
  webapp.site/    (its site; index.html at the root)
```

Anything that can write files can publish: a manual copy, a build script, a workflow. Directory requests serve `index.html`, and a `404.html` at the site root, if present, is used for missing paths. When the directory exists, a Site tab appears in the repository's navigation.

GitHub calls this feature Pages, and earlier versions of hubbit did too, with the directory named `<repo>.pages`. We renamed it because "pages" already means something else in a web interface made of pages. A vault created before the rename needs one command per site: `mv <repo>.pages <repo>.site`.

## Workflows

A vault runs GitHub Actions workflows, with one deliberate difference: **jobs never execute on the machine serving the vault**. That machine holds repositories and answers HTTP; giving it a container runtime and letting pushed code run on it is the wrong shape for a small server, and worse for a shared one. Instead the server plans runs and hands them out, and a *runner* you start somewhere with Docker takes them:

```bash
hubbit runner add laptop --allow 'mycollection/*'    # on any machine, with an admin token
hubbit runner run --host https://vault.example.com --runner-token hubbit_runner_...
```

A vault with no runner is not broken; its runs queue and wait, and the Actions tab says so. Start a runner and they go.

Workflows are read from two directories:

```
.hubbit/workflows/*.yml     preferred
.github/workflows/*.yml     also read, so repositories work unchanged
```

Both are collected. A file in `.hubbit/workflows` shadows one with the same basename in `.github/workflows`, which is how a repository adapts a single workflow for hubbit without forking the rest of them. The workflow syntax is GitHub's, the context is spelled `github`, and the environment variables are the `GITHUB_*` ones, because compatibility is the whole point of the layer.

### What runs today

Triggers are `push` (with `branches`, `tags`, and `paths` filters, plus their `-ignore` forms) and `workflow_dispatch` with typed inputs, which the Actions tab renders as a form. A commit made in the web interface is a push like any other and fires the same workflows.

Within a run: the `${{ }}` expression language, `needs` between jobs, `strategy.matrix` with `include`, `exclude`, and `fail-fast`, `if` on jobs and steps (including `always()`, `failure()`, and `cancelled()`), `env` at workflow, job, and step level, `concurrency` groups with `cancel-in-progress`, `continue-on-error`, `timeout-minutes`, job `outputs`, and `defaults.run`.

Within a step: `run` with `shell` and `working-directory`, the file commands (`GITHUB_OUTPUT`, `GITHUB_ENV`, `GITHUB_PATH`, `GITHUB_STEP_SUMMARY`), and the stdout commands (`::group::`, `::error::`, `::add-mask::` and friends). Values passed to `::add-mask::` are redacted from every later log line, on the runner, before the line is sent to the vault.

Steps that `use:` an action run too. JavaScript actions (`node16`, `node20`, `node24`) and composite actions work, nested to any depth, with their `pre` and `post` scripts; actions are fetched from github.com as source tarballs and cached on the runner. A local action (`uses: ./.github/actions/thing`) comes from the repository being built. Docker actions (`runs.using: docker`) are not implemented and fail the step with a message saying so, as do reusable workflows, `container:` jobs, and `services:`.

Not implemented: secrets, `actions/cache` and the cache service, `hashFiles()`, and a token for the run (so an action that calls a forge API gets no credential, and one that needs it will say so).

### Actions hubbit implements itself

A few actions are not ordinary programs: they are clients for services that exist only inside GitHub. Running them verbatim against a vault cannot work, so hubbit substitutes its own implementation of the same interface, chosen by the `uses:` string and applied at any nesting depth, including inside somebody else's composite action.

| `uses:` | What hubbit does instead |
| --- | --- |
| `actions/checkout` | Reports the checkout the runner already made; does real work for another repository, ref, path, `fetch-depth: 0`, or submodules |
| `actions/upload-artifact` | Tars the matched paths and stores them in the run's directory in the vault |
| `actions/download-artifact` | Restores one, or all of the run's artifacts, into the workspace |
| `actions/configure-pages` | Reports this vault's site URL and base path, and exports `HUBBIT_SITE_BASE_PATH` |
| `actions/deploy-pages` | Publishes the `github-pages` artifact as the repository's site |

Everything else runs unmodified, `actions/setup-node` and the rest included. Note that `actions/upload-pages-artifact` is *not* substituted: it is an ordinary composite action that tars a directory and calls `upload-artifact`, so the real one works as it is, on top of hubbit's `upload-artifact`.

Substituting by name rather than implementing GitHub's artifact and Pages wire protocols is a deliberate trade: far less code, at the cost of following a handful of action interfaces as they change.

### Artifacts

`upload-artifact` stores a tar in the run's directory, `download-artifact` restores it in a later job of the same run, and the run page lists what was produced with a download link. Anonymous, like every other read in a vault. Artifacts are pruned with their run, and a job may not upload more than `ci.artifactMb` (500 MB by default).

Artifacts are addressed by the job's lease, so only a job that is actually running can write one, and only into its own run.

### Two divergences worth knowing

hubbit checks the repository out into the workspace before the job starts. On GitHub the workspace begins empty and `actions/checkout` fills it, and hubbit's `checkout` is a re-sync of what is already there. A workflow that deliberately wants an empty workspace will be surprised.

A site is served at `/<collection>/<repo>/site/`, while GitHub serves one at `<owner>.github.io/<repo>/`. A site generator that reads `base_path` from `configure-pages` gets the right answer; one that computes its own from the repository name gets GitHub's shape and produces broken links. Pass the base path explicitly in that case, or have the generator emit relative URLs.

### Running actions needs node in the container

JavaScript actions need a node interpreter inside the job's container. If the image has one new enough, that one is used and nothing is downloaded, which is the usual case for CI images. Otherwise the runner downloads the official build once, caches it, and mounts it read-only into every container, so a bare `ubuntu:24.04` runs `actions/checkout` too. Those builds are linked against glibc, so a musl image (Alpine) needs node in the image; the runner says so rather than failing obscurely.

### Runners

A runner is registered against the vault and holds a token of its own, distinct from any user's:

```bash
export HUBBIT_HOST=https://vault.example.com
export HUBBIT_TOKEN=<a token with admin scope>
hubbit runner add laptop --allow 'mycollection/*' --labels ubuntu-latest
```

`--allow` takes globs over `collection/repo` and is the security boundary that matters: **a runner executes whatever those repositories' workflows contain, on the machine you start it on.** Registering one requires admin scope over exactly the globs being granted, the same rule that governs handing out push access. Grant a runner the repositories you would let run code on that machine, and no more. Docker is isolation against accidents, not against someone who wants your laptop.

The token is shown once, and only its hash is stored, as with user tokens. `--save` writes it to `~/.config/hubbit/runner.json` (mode 0600) so later runs need no arguments. Registration is also available under **Admin > Runners** in the web interface.

Running one:

```bash
hubbit runner run                        # using the saved configuration
hubbit runner run --labels ubuntu-latest --image ubuntu-latest=ghcr.io/me/ci:latest
```

The runner long-polls for a job, so it needs no inbound connectivity and works behind NAT and through any ordinary HTTP proxy. It takes one job at a time, runs the whole job in a single container (steps `exec` into it, so what one step installs is there for the next), streams logs back as it goes, and reports the result. Ctrl-C finishes the current job and stops.

Actions named by `uses:` are downloaded from `https://github.com` and cached under `~/.cache/hubbit`, which `--actions-url` and `--cache-dir` change. The ref is resolved to a commit first, with one `git ls-remote`, and the cache entry is keyed by that commit: a branch or tag that has moved is picked up on the next run, and one that has not is never downloaded again. The log says which commit an action resolved to and whether the copy came from the cache, so a run that used an old copy is not mistaken for one that used the tip. A forge that cannot answer `ls-remote` falls back to keying by name and re-fetching after a day, and says so. `--no-action-cache` downloads every time.

`runs-on` labels map to images. The defaults cover `ubuntu-latest`, `ubuntu-24.04`, `ubuntu-22.04`, and `self-hosted` with the [`catthehacker`](https://github.com/catthehacker/docker_images) images that `act` also uses; `--image <label>=<image>` overrides any of them, and an unmapped label that looks like an image name (`runs-on: node:24`) is used as one. Note that the images decide what your workflows can assume: a bare `ubuntu:24.04` has no node, no python, and no compilers.

If the runner dies mid-job, the server notices the lease expire and requeues the job; after three attempts it fails it with a message naming the runner, rather than retrying forever.

### Runs in the vault

Run state is files, like everything else:

```
<vault>/mycollection/myrepo.runs/
  12/
    run.json          the run: trigger, ref, sha, status, job order
    jobs/build.json   one per job: steps, timings, outputs
    jobs/build.log    the log, one JSON object per line
```

Runs are the one part of a vault that grows without bound, so they are pruned. The default keeps the last 100 completed runs per repository; `config.json` tunes it:

```json
{ "theme": "paper", "ci": { "runs": 100, "days": 30, "artifactMb": 500 } }
```

`days` of `0` disables the age rule. Active runs are never pruned. `artifactMb` caps a single artifact upload.

## Git LFS

A vault keeps every byte ever committed, since repositories are stored as bare git repositories on a filesystem. That is fine for source code and expensive for large binary files, which grow the vault without bound and cannot be pruned without rewriting history. [Git LFS](https://git-lfs.github.com/) replaces those files in the repository with small pointer files and keeps the actual bytes elsewhere, so the repository stays small and the large objects live in inexpensive object storage. The trade-off is latency: fetching an LFS object is a separate HTTP request rather than bytes already present in a packfile the client just downloaded.

Nothing needs to be enabled. The server implements the LFS Batch API on every repository, and clients find it without configuration:

```bash
git lfs track '*.nwb'
git add .gitattributes data/session.nwb
git commit -m "Add a recording"
git push
```

Downloading is anonymous, so `git clone` followed by `git lfs pull` on a public repository needs no credentials; uploading requires push scope over the repository, the same token and the same scope as `git push`. There is no separate LFS permission and no per-repository setting to turn on.

Push-to-create still works for a repository that tracks files with LFS. git fetches the remote's refs before it runs the pre-push hook that uploads the objects, and it is that first request which creates the repository here, so the objects arrive at a repository that already exists.

Objects are stored either in an S3-compatible bucket or inside the vault, chosen from the environment at startup. With no bucket variables set, the **local** backend stores objects in a sibling directory next to the repository, following the same convention as sites:

```
<vault>/alice/
  webapp.git/     (the repository, holding pointer files)
  webapp.lfs/     (its LFS objects, sharded by object id)
```

This keeps `npm run dev` and the smoke test working with no credentials and is a reasonable choice for a laptop vault, but it stores the large objects on the same disk the feature exists to protect. For a deployment with a small volume, point it at a bucket instead. The server then returns presigned URLs and the client transfers bytes directly to and from the bucket, so large-file content never passes through the hubbit process.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HUBBIT_LFS_BUCKET` or `BUCKET_NAME` | unset | Bucket name |
| `HUBBIT_LFS_ENDPOINT` or `AWS_ENDPOINT_URL_S3` | unset | S3 endpoint base URL |
| `AWS_ACCESS_KEY_ID` | unset | Access key |
| `AWS_SECRET_ACCESS_KEY` | unset | Secret key |
| `AWS_REGION` | `auto` | Credential-scope region; `auto` is correct for R2 and Tigris |
| `HUBBIT_LFS_PREFIX` | unset | Optional key prefix, so LFS can share a bucket with other data |
| `HUBBIT_LFS_MAX_SIZE` | `5000000000` | Largest object accepted, in bytes |
| `HUBBIT_LFS_ADDRESSING` | `path` | `path` or `vhost`; path style is required by R2 |
| `HUBBIT_LFS` | unset | Set to `off` to force the local backend even with bucket variables present |

Credentials are read from the environment only and are never written into `config.json` or `vault.json`: the vault is the backup unit and stays portable between deployments with different buckets. Setting some but not all of the four bucket variables is a startup error that names what is missing, rather than a silent fall back to storing large objects on the volume. The server logs which backend is active on each start.

Object keys are identical in both backends (`<collection>/<repo>.lfs/<oid[0:2]>/<oid[2:4]>/<oid>`), so moving a vault between them is `rclone copy` and nothing else.

### Storage providers

All three use the same code path.

- **Cloudflare R2** (recommended). Endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, region `auto`, path-style addressing. Storage is $0.015/GB-month with no egress fees, and the free tier covers 10 GB, 1 million Class A operations, and 10 million Class B operations per month. Use Standard storage rather than Infrequent Access: IA saves a third on storage but doubles operation costs, adds $0.01/GB retrieval, imposes a 30-day minimum storage duration, and is excluded from the free tier, which suits objects people occasionally clone poorly.
- **Tigris** (convenient on Fly). `fly storage create` provisions a bucket and injects `BUCKET_NAME`, `AWS_ENDPOINT_URL_S3`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY` as Fly secrets, so there is nothing further to configure.
- **Amazon S3.** Set `AWS_REGION` to the bucket's real region, and `HUBBIT_LFS_ADDRESSING=vhost` if path-style addressing is unavailable for the bucket.

Bucket CORS needs no configuration. The git-lfs client is not a browser, and the download link on a file's page is a top-level navigation, so neither path is subject to CORS.

### In the web interface

A file stored with LFS shows a download card giving its true size and object id, rather than the pointer text; the download link redirects to the object in storage. `?plain=1` shows the pointer source, as GitHub does. Editing such a file in the browser is refused, since committing ordinary text over a pointer would silently corrupt the repository's LFS state; deleting it is still allowed, as it is a legitimate git operation. Deleting a repository removes its stored objects along with it.

### Limitations

- **Existing large files are unaffected.** LFS prevents future growth; it does not shrink a repository retroactively. Files already committed as ordinary blobs stay in the packfiles, and moving them requires `git lfs migrate import` on a client, which rewrites history and changes every downstream commit id.
- **Directory listings show pointer sizes.** Tree listings take their sizes from `git ls-tree -l`, which reports the pointer's size of roughly 130 bytes rather than the real file size. The file's own page shows the true size.
- **Commit diffs show pointer diffs**, which is git's own behavior without the LFS diff driver configured.
- **Orphaned objects leak.** Objects whose commits never arrived, or which became unreachable through a force push or a branch deletion, stay in storage. Collecting them properly means enumerating every pointer blob reachable from every ref across all history; a `hubbit lfs gc` is left for later.
- **Object size is capped** by `HUBBIT_LFS_MAX_SIZE`, because the `basic` transfer adapter uploads with a single PUT. Note what the cap is worth in each backend. Locally it is enforced on the bytes as they arrive. Against a bucket it can only be enforced on the size the client declares in the batch request, since the upload goes straight to the bucket: someone with push access who declares a small size and then sends a large body will succeed, and the bytes become orphans that `verify` reports but nothing removes. Treat it as a guard against honest mistakes rather than a quota, and use bucket-side limits or billing alerts if you need a real one.
- **File locking is not implemented.** The `/locks` endpoints return 404, which git-lfs reads as locking being unsupported.

## Making a remote vault

A remote vault is the same server with a persistent disk and TLS in front; there is nothing else to it, since the vault directory is the entire state. The repository ships a container recipe with git included. On first start the server initializes the vault and prints the owner token to the logs; from then on all administration happens from your own machine, on the web or through `HUBBIT_HOST` and `HUBBIT_TOKEN`.

On any machine with Docker:

```bash
docker build -t hubbit .
docker run -d --name hubbit -p 3000:3000 -v ./vault:/vault hubbit
docker logs hubbit    # copy the one-time owner token
```

This serves plain HTTP, which is fine on a trusted or private network (a Tailscale or WireGuard address, say) but not on the open internet, since tokens travel as Basic-auth passwords and session cookies are only marked `Secure` behind HTTPS.

With a domain name pointed at the machine, the included `docker-compose.yml` adds Caddy for automatic HTTPS:

```bash
DOMAIN=hubbit.example.org docker compose up -d
docker compose logs hubbit            # the owner token
export HUBBIT_HOST=https://hubbit.example.org
export HUBBIT_TOKEN=<owner token>
hubbit user add alice --scope 'alice/*'
git clone https://hubbit.example.org/alice/some-repo
```

Without a server of your own, the same container runs on Fly.io. After `fly auth login`, one command does everything:

```bash
./scripts/deploy-fly.sh my-vault-name
```

That creates the app and a volume, deploys a single machine, and prints the one-time owner token together with the `HUBBIT_HOST` and `HUBBIT_TOKEN` lines to export. Pick your own name, since Fly app names are globally unique. Re-running it deploys an update, reusing the existing app and volume.

By hand, the same thing is:

```bash
fly apps create my-vault-name
fly volumes create vault --app my-vault-name --region ewr --size 10 --yes
fly deploy --app my-vault-name --ha=false
fly logs --app my-vault-name
```

Passing `--app` on each command overrides the placeholder name in `fly.toml`, so there is nothing to edit. Note `--ha=false`: a vault is a directory on a single volume, so this app must run as one machine. Two machines would mean two volumes and two vaults that silently diverge. For the same reason, scaling up means a bigger machine rather than more of them.

The server honors `X-Forwarded-*` headers, so clone URLs, cookies, and the web UI behave correctly behind any of these proxies.

Backing up a vault is copying a directory. Moving it to another host, or from your laptop to the cloud, is copying it there. Note that rate limiting and abuse controls for public vaults are not implemented; a vault on the open internet is readable by anyone, so say so in your own deployment notes.

## Roadmap

The project direction is specified in [SPEC.md](SPEC.md). The phase described there as "a web interface that performs operations" is implemented; nearer-term items now are:

- Secrets, and a scoped token for the run, so a workflow can push back to its own repository and call the vault's API
- `actions/cache`, so dependency installs stop being repeated on every run
- Docker actions, `container:` jobs, and service containers
- Issues and pull requests, stored in the vault (design in SPEC.md, undecided between sibling directories and in-repo refs)
- JSON responses on the read routes via content negotiation, and UI operations mirrored into the API
- Federation between vaults: forking and cross-vault pull requests
