# repos

Hosting git repositories usually means running a service with a database (GitHub, GitLab, Gitea). A limitation of that approach is that the state of the system lives somewhere you cannot see directly. Here we take a simpler route: the filesystem is the database. You have a directory we call a vault, each subdirectory of the vault is an organization, and each subdirectory of an organization is a bare git repository. Point the server at the vault and you get a GitHub-style web interface for browsing and operating on the repositories, anonymous clone access over HTTP, and token-authenticated push.

```
<vault>/
  vault.json              (users and hashed tokens; created on first start)
  .secret                 (session-cookie signing key; created on first need)
  alice/
    hello-numerics.git/   (bare repository)
    webapp.git/
    webapp.pages/         (static pages site for webapp)
  bob/
    notes.git/
```

The `.git` suffix on repository directory names is optional; it is stripped for display either way.

## Features

- Organization and repository listings
- File browsing at any branch or tag, with syntax highlighting
- Markdown files rendered as documents, with a Preview/Code toggle (`?plain=1` for the source, as on GitHub); READMEs shown on directory pages
- The GitHub markdown feature set: highlighted code with a copy button, LaTeX math through KaTeX (`$…$`, `$$…$$`, and ```` ```math ```` blocks), tables, task lists, footnotes, alert callouts (`> [!NOTE]`), emoji shortcodes, heading anchors, and a sanitized subset of inline HTML
- Commit history with pagination, and per-commit diff views
- Sign-in with username and token; operations happen directly in the web interface:
  - creating repositories (with an optional initial README)
  - editing, creating, and deleting files, committed straight to a branch
  - creating and deleting branches and tags
  - repository settings: description, default branch, and deletion
  - user administration: creating users, granting scopes, minting tokens
  - a choice of themes for the vault (see below)
- Anonymous `git clone http://host:port/org/repo` over smart HTTP
- Authenticated `git push`, including push-to-create for new repositories
- A JSON API and a `repos` CLI for user management
- Per-repository pages sites served from a sibling `<repo>.pages` directory

There is no database and no build step for the frontend: all state lives in the vault directory, and the server renders plain HTML.

## Quick start

```bash
npm install
npm run example    # creates example-root/ with sample orgs, repos, and a dev user
npm run dev        # serves example-root/ at http://127.0.0.1:3000
```

The example vault includes a user `dev` with the fixed token `repos_example_dev_token` (full push and admin scope, example vault only). Sign in with it on the web interface to see the operational controls.

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

The interface ships with a small collection of themes, chosen under **Admin > Appearance**:

| Theme | Look |
|---|---|
| `paper` | Warm off-white with teal links and serif headings. The default. |
| `github` | The familiar light gray and blue, for people who want no surprises. |
| `slate` | Cool gray surfaces with an indigo accent. |
| `midnight` | A dark theme with azure links, for low light. |
| `terminal` | Near-black, phosphor green, monospace throughout. |

A theme is a property of the vault rather than of the visitor: one vault is one site, and the operator picks how it looks. The choice lives in `<vault>/config.json`, so it can equally be set by hand before the first start, and the server picks up an edit without a restart:

```json
{ "theme": "midnight" }
```

Changing it in the UI requires admin scope over the whole vault (`*`); an administrator delegated to one organization can manage users there but cannot restyle the site. An unknown theme name falls back to the default rather than failing requests, so a typo in `config.json` cannot take the site down.

Each theme is a set of semantic CSS custom properties (background, surface, border, accent, diff colors, fonts, corner radius) plus the highlight.js palette that suits it. The structural stylesheet in `src/style.ts` names no colors of its own, so adding a theme means adding one entry to `src/themes.ts`.

## The repos command

Everything is available as `node dist/index.js <command>` after `npm run build`. To get a `repos` command on your PATH instead, link the package from a checkout:

```bash
npm run build
npm link          # then: repos --help
```

Use `npm unlink -g repos` to remove it. Note that with a version manager such as fnm or nvm the link belongs to the active Node version, so switching versions hides it until you link again.

`repos serve` is the only command that touches the vault directory (set it positionally or with `REPOS_VAULT`). Every other command talks to a running server, so it works the same whether the vault is on your machine or across the network:

```bash
export REPOS_HOST=http://127.0.0.1:3000
export REPOS_TOKEN=<a token with admin scope>
repos whoami
repos user list
```

`--host <url>` and `--token <t>` override the environment per command. By default the server binds 127.0.0.1. Use `--host 0.0.0.0` on `serve` to expose it on the network; note that this exposes read access to every repository in the vault, and that tokens then travel over plain HTTP unless you put TLS in front. The first line of the `description` file inside a bare repository is shown in listings, as with classic git hosting.

## Pushing

The first token comes from the server's first start (the printed owner token). With that you can create users on the web (Admin, in the header) or over the API:

```bash
repos user add jeremy
```

This creates the user in `<vault>/vault.json` on the server and prints the token once; only its SHA-256 hash is stored. Then push with the username and the token as the password:

```bash
git push http://127.0.0.1:3000/myorg/myrepo main
# git prompts: username 'jeremy', password '<token>'
```

Pushing to a repository that does not exist yet creates it, provided the target matches your scope; the org directory is created as needed, and after the first push HEAD points at the pushed branch. Repositories created this way get `receive.denyNonFastForwards`, `receive.denyDeletes`, and a `receive.maxInputSize` limit of 2 GiB. Anonymous fetch stays open; only pushes require authentication.

### Importing an existing repository

Importing runs on your machine, not on the server. Sign in, open **Import** on any organization page (or go to `/import`), give it a GitHub URL or `owner/repo`, and the page writes the exact command:

```bash
git clone --bare https://github.com/owner/repo.git repo.import.git && \
  git -C repo.import.git push --mirror https://you@vault.example.com/myorg/repo && \
  rm -rf repo.import.git
```

git asks for a password on the push: that is your repos token. The push creates the repository, so the target must not exist yet, and your push scope has to cover it. Branches and tags come across. Issues, pull requests, and git-lfs objects do not, and the description is set afterwards in repository settings.

The clone is `--bare` rather than `--mirror` on purpose: mirroring a GitHub repository also copies `refs/pull/*`, which can be thousands of refs.

### Users, tokens, and scopes

`vault.json` holds a `users` object. Each user has a list of hashed tokens, a list of push scope globs, and a list of admin scope globs, all matched against `org/repo`, where `*` matches any characters including `/`:

```json
{
  "users": {
    "owner": { "scope": ["*"], "admin": ["*"], "tokens": [{ "hash": "..." }] },
    "ci": { "scope": ["myorg/*"], "admin": [], "tokens": [{ "hash": "...", "scope": ["myorg/site"] }] }
  }
}
```

`scope` says where the user may push (and, on the web, create repositories and edit files). `admin` says where the user may manage other users and delete repositories: an owner has `admin: ["*"]`, while `admin: ["myorg/*"]` lets a user hand out push access within `myorg` but nowhere else. A token may carry its own scope, which is intersected with the user scope; this is useful for minting a narrowly scoped token (`--token-scope`) without changing the user. Such restricted tokens carry no admin rights at all. New users default to push scope `["*"]` and no admin scope. The server re-reads the file when it changes; hand-editing it remains possible and is the escape hatch for locked-out vaults. If the file cannot be parsed, writes refuse until it is fixed, while read access continues to work.

### Granting access to an organization or repository

Permission is granted by adding scope globs to a user, using an actor whose admin scope covers the globs being granted. On the web this is the Grant form on the users page; over the CLI:

```bash
repos user add alice --scope 'myorg/*'      # create with access to one org
repos user grant alice --scope 'otherorg/*' # extend an existing user
repos user grant alice --admin 'myorg/*'    # delegate user management for myorg
repos user list                             # review who can push where
```

Note that `--scope` on `repos user add` applies only when creating a user; on an existing user the command refuses rather than silently replacing their permissions (run it without `--scope` to mint an additional token).

### JSON API

The CLI is a thin client over a small API, authenticated with `Authorization: Bearer <token>`:

```
GET  /api/whoami                user, scopes, and restriction of the presented token
GET  /api/users                 list users (admin required)
POST /api/users                 create a user or mint a token  {username, scope?, admin?, tokenScope?}
POST /api/users/:name/grant     extend a user's scopes         {scope?, admin?}
```

The API accepts only bearer tokens and git accepts only Basic auth; session cookies never authorize either. The two credential presentations stay deliberately distinct.

## Pages sites

A repository can have a static site, served at `/<org>/<repo>/pages/`. The content is plain files in a sibling directory next to the bare repository:

```
<root>/alice/
  webapp.git/     (the repository)
  webapp.pages/   (its pages site; index.html at the root)
```

Anything that can write files can publish: a manual copy, a build script, later CI. Directory requests serve `index.html`, and a `404.html` at the site root, if present, is used for missing paths. When the pages directory exists, a Pages tab appears on the repository's web pages.

## Making a remote vault

A remote vault is the same server with a persistent disk and TLS in front; there is nothing else to it, since the vault directory is the entire state. The repository ships a container recipe with git included. On first start the server initializes the vault and prints the owner token to the logs; from then on all administration happens from your own machine, on the web or through `REPOS_HOST` and `REPOS_TOKEN`.

On any machine with Docker:

```bash
docker build -t repos .
docker run -d --name repos -p 3000:3000 -v ./vault:/vault repos
docker logs repos    # copy the one-time owner token
```

This serves plain HTTP, which is fine on a trusted or private network (a Tailscale or WireGuard address, say) but not on the open internet, since tokens travel as Basic-auth passwords and session cookies are only marked `Secure` behind HTTPS.

With a domain name pointed at the machine, the included `docker-compose.yml` adds Caddy for automatic HTTPS:

```bash
DOMAIN=repos.example.org docker compose up -d
docker compose logs repos            # the owner token
export REPOS_HOST=https://repos.example.org
export REPOS_TOKEN=<owner token>
repos user add alice --scope 'alice/*'
git clone https://repos.example.org/alice/some-repo
```

Without a server of your own, the same container runs on Fly.io. After `fly auth login`, one command does everything:

```bash
./scripts/deploy-fly.sh my-vault-name
```

That creates the app and a volume, deploys a single machine, and prints the one-time owner token together with the `REPOS_HOST` and `REPOS_TOKEN` lines to export. Pick your own name, since Fly app names are globally unique. Re-running it deploys an update, reusing the existing app and volume.

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

- Issues and pull requests, stored in the vault (design in SPEC.md, undecided between sibling directories and in-repo refs)
- JSON responses on the read routes via content negotiation, and UI operations mirrored into the API
- A post-receive hook that builds `<repo>.pages` on push, growing into CI
- Federation between vaults: forking and cross-vault pull requests
