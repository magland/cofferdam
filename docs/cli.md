# The command line

The `cofferdam` command, how it is configured, how pushing is authorized, and the API underneath it.

Installing the package globally puts a `cofferdam` command on your PATH:

```bash
npm install -g @magland/cofferdam    # then: cofferdam --help
```

From a checkout, everything is available as `node dist/index.js <command>` after `npm run build`, or link the checkout to get the command while keeping your edits live:

```bash
npm run build
npm link          # then: cofferdam --help
```

Use `npm unlink -g @magland/cofferdam` to remove either one. Note that with a version manager such as fnm or nvm the link belongs to the active Node version, so switching versions hides it until you link again.

`cofferdam serve` is the only command that touches the vault directory (set it positionally or with `COFFERDAM_VAULT`). Every other command talks to a running server, so it works the same whether the vault is on your machine or across the network. Say which vault and with which token once, by logging in:

```bash
cofferdam login http://127.0.0.1:3000    # asks for the token, without echo
cofferdam whoami
cofferdam user list
cofferdam collection add mycollection
cofferdam import https://github.com/owner/repo mycollection
```

`cofferdam login` is the way to configure the CLI for a person at a keyboard: no token to re-supply per command, and nothing to set in the environment. The vault URL is remembered in `~/.config/cofferdam/login.json` (mode 0600) and the token goes to git's own credential store, which is where git needs it anyway for pushing, so a token is kept in one place rather than two (see [Not typing the token every time](#not-typing-the-token-every-time)). `cofferdam logout` undoes both.

A caller in a container is in a different position: it has no keyring, may have no writable home directory, and gets its secrets as environment variables. So `COFFERDAM_HOST` and `COFFERDAM_TOKEN` are honoured by every command that talks to a vault, and `--token-stdin` reads a token from stdin so that it appears in neither argv nor shell history. Precedence for both the host and the token is the same: the option, then the environment, then what `cofferdam login` left behind.

```bash
export COFFERDAM_HOST=https://vault.example.com
export COFFERDAM_TOKEN="$(cat /run/secrets/cofferdam)"
cofferdam whoami --json
```

(`cofferdam runner run` reads `COFFERDAM_RUNNER_TOKEN` as well, since a runner holds a token that is not any user's.)

`cofferdam deploy fly <app>` is the exception to the division above in one respect: it drives flyctl rather than a vault, since at the moment it runs there is no vault yet. It creates a vault on Fly.io, or deploys an update to an existing one, and on a new one it mints the owner token locally and prints it once the server has confirmed it, together with how to sign in on the web and the `cofferdam login` line that stores it for the CLI and git (see [Deploying a vault](deploying.md)). The deploy itself stores nothing: logging in stays a separate, deliberate step.

Note that login is a client-side arrangement only: it calls the server once to check who the token belongs to, and writes nothing but local files. `cofferdam runner run` is the one command that reads a configuration of its own, since a runner holds a token that is not any user's: it is a long-running process that takes workflow jobs from a vault and executes them locally in Docker (see [Workflows](workflows.md)).

`--host <url>` and `--token <t>` override the login per command, which is how you reach a second vault without logging out of the first. By default the server binds 127.0.0.1. Use `--host 0.0.0.0` on `serve` to expose it on the network; note that this exposes read access to every repository in the vault, and that tokens then travel over plain HTTP unless you put TLS in front. The first line of the `description` file inside a bare repository is shown in listings, as with classic git hosting.

## Finding your way around

Help is per command rather than one dump of all of them, which keeps any single piece of it short enough to read:

```bash
cofferdam --help              # command groups, and the commands that stand alone
cofferdam user --help         # the commands in one group
cofferdam user add --help     # one command's arguments and options
cofferdam commands --json     # every command, argument, and option, as data
```

`cofferdam commands --json` is the whole registry, which is enough to discover the surface without reading any of this.

### Output and exit codes

Every command that reads something takes `--json`, which puts a single JSON value on stdout and sends every diagnostic to stderr, so `cofferdam issue list --json | <parser>` never has to filter anything out. A comma-separated field list keeps only those fields, as `gh` does: write it attached, `--json=number,title`, or detached when it names more than one field, `--json number,title`. A name that is not a field of the response is an error naming the ones that are.

Failures are also JSON when `--json` was asked for: `{"error": "..."}` on stderr, and a non-zero exit.

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Generic failure, including a 4xx or 5xx from the vault with no code of its own |
| 2 | Usage error: unknown command, unknown flag, missing argument |
| 3 | Authentication failure: no token, or the vault rejected it (HTTP 401) |
| 4 | Not found: the vault answered 404 for the addressed resource |
| 5 | Conflict: the vault answered 409, or the operation was refused because of state |

4 and 5 are the two worth branching on, since "does this exist" and "did someone else get there first" are the questions a retrying caller asks.

### Working on a repository

The repository commands read and write a repository over the API, so they need no clone:

```bash
cofferdam repo list                        # every repository in the vault
cofferdam repo view demo/proj
cofferdam branch list --repo demo/proj
cofferdam file list --repo demo/proj       # one directory
cofferdam file list --all                  # every path in the tree
cofferdam file view README.md
cofferdam commit list --limit 10
cofferdam commit view <sha> --patch
cofferdam diff main...topic
cofferdam search 'needle'
```

Which repository a command is about is resolved in this order: the positional argument or `--repo <collection>/<repo>`, then `COFFERDAM_REPO`, then the git remote in the current directory that points at the vault you are logged in to, preferring `origin`. A remote for some other host is not an answer, so a clone of a GitHub repository is never read as naming something here. Failing all three, the command says so and names all three.

### Changing a repository

```bash
cofferdam repo create mycollection/thing --description 'A thing' --readme
cofferdam repo edit --description 'A better thing'
cofferdam repo fork demo/proj myfork
cofferdam repo rename demo/proj newname --collection othercollection
cofferdam repo delete demo/old --yes
cofferdam repo clone demo/proj

cofferdam branch create topic
cofferdam branch delete topic --yes
cofferdam tag create v1.0.0 main
cofferdam tag delete v1.0.0 --yes

cofferdam file write notes.md --message 'Add notes' < notes.md
cofferdam file delete notes.md --yes
```

Everything destructive takes `--yes` and refuses without it, rather than prompting: a prompt is no use to a caller that is not a person, and a command that prompts is a command that hangs in a container.

`cofferdam file write` reads the content from `--body`, from `--body-file`, or from stdin when neither is given, so a generated file can be piped straight in. Given `--expected-sha`, a branch that has moved since is a conflict (exit 5) rather than a silent overwrite, which is exactly what a caller that reads, thinks, and then writes wants:

```bash
sha="$(cofferdam file view config.json --json=commit | jq -r .commit)"
# ... work out the new content ...
cofferdam file write config.json --expected-sha "$sha" --body-file new.json
```

Several files as one commit is a single call, since three files changed as one logical edit should be one commit and not three:

```bash
cofferdam api repos/demo/proj/commits -X POST --input change.json
```

A commit made this way is a push as far as workflows are concerned, so it triggers the same runs a `git push` would.

### Issues and pull requests

```bash
cofferdam issue list --state all
cofferdam issue view 12 --comments
cofferdam issue create --title 'It broke' --body-file report.md --label bug
cofferdam issue edit 12 --add-label urgent
cofferdam issue comment 12 --body-file -        # from stdin
cofferdam issue close 12

cofferdam pr list
cofferdam pr create --base main --head topic --title 'Add a thing'
cofferdam pr diff 4
cofferdam pr merge 4 --squash --delete-branch
cofferdam pr checks 4
cofferdam pr close 4
```

`--body-file` exists alongside `--body` on every command that takes a body, and `-` reads stdin: an issue body is frequently longer than a shell argument should be. Asking for both is an error rather than a precedence question.

Two things are worth knowing about merging. Whether a merge would apply can be asked without merging anything, which is the read to make first:

```bash
cofferdam api repos/demo/proj/pulls/4/merge
```

And a merge that does not apply exits 5 and names the conflicting paths, so a caller can tell "it does not apply" from "it went wrong".

`cofferdam pr checks` deserves its own note: cofferdam has no equivalent of a check suite or a commit status, so there is nothing behind that command but the workflow runs whose commit is the pull request's head. That is what it reports, and that is all it means.

### Workflows and their runs

```bash
cofferdam workflow list                        # workflows at a ref, and the inputs each takes
cofferdam workflow run .github/workflows/build.yml --field greeting=hello
cofferdam run list --status completed
cofferdam run view 12                          # the run, its jobs, and their step states
cofferdam run view 12 --log                    # and the failed job's log
cofferdam run watch 12 --exit-status
cofferdam run cancel 12
cofferdam run rerun 12
cofferdam run download 12 --dir artifacts
```

A job log comes back as its last 200 lines by default. That is not a convenience: a log can be large, and handing the whole of one to a caller that is diagnosing a failure wastes its attention on the part that succeeded. `--tail 0` asks for all of it, and the response says whether it kept only the end and whether the server capped the log as it was written, which are different things.

`run view --log` without `--job` picks the failed job, or the only job. When neither applies it asks rather than guessing.

`cofferdam run watch` polls until the run finishes and then reports how it went; `--exit-status` makes a failed run a non-zero exit, which is what a script wants. It polls rather than streams because the engine has no event channel and the vault reads its state off disk per request, so a five-second poll against a local process costs nothing and needs no protocol. Note that a vault with no runner registered queues its runs and waits, so a watch there will reach its timeout.

### Releases, users, and settings

```bash
cofferdam release list
cofferdam release create v1.0.0 --title 'First cut' --notes-file NOTES.md
cofferdam release edit v1.0.0 --latest          # clear the prerelease flag
cofferdam release delete v1.0.0 --yes

cofferdam user view alice
cofferdam user token list alice
cofferdam user token revoke alice <token-id> --yes
cofferdam user delete alice --yes
cofferdam collection delete emptyone --yes

cofferdam config view
cofferdam config set --theme slate --ci-runs 50
```

A release hangs on a tag that already exists: notes for a tag nobody can check out are notes about nothing, so `cofferdam tag create` comes first. Creating and editing are the same call underneath, since a release is keyed by its tag, which takes a whole class of "already exists, retry as an edit" logic out of a caller. Deleting a release deletes its notes and leaves the tag; the two are separate operations.

There is no `release upload`. A release's downloads are the archive routes, so there is nothing to upload and no asset endpoints exist.

Tokens are named by an id rather than by their hash, and neither a token nor its hash is ever returned: only a SHA-256 hash is stored, so there is nothing to return. An id, a creation time, and any scope of its own is what a listing gives, which is what revocation takes. Revoking the token you are using is allowed and reported rather than refused; locking yourself out is your business, and `vault.json` remains hand-editable.

`cofferdam config set` reaches the theme and the CI retention settings and nothing else. `network.trustProxy`, the `limits` block, and `sites.host` are read once when the server starts (see [Deploying a vault](deploying.md)), so a command that changed them would report a change the running server had not made. Edit `config.json` in the vault and restart.

### Reaching any route: `cofferdam api`

`cofferdam api` sends a request to any route of the JSON API and prints what comes back, so a capability with no typed command of its own is still one line away:

```bash
cofferdam api whoami
cofferdam api collections -X POST --field name=mycollection
cofferdam api collections/mycollection
```

The path may be written with or without a leading slash and with or without the `api/` prefix, so `whoami` and `/api/whoami` name the same route. `--field k=v` builds a JSON body, coercing `true`, `false`, `null`, and whole numbers; `--raw-field k=v` keeps the value a string; `--input <file>` sends a file as the body, or stdin for `-`. The method defaults to GET, or POST when a body is given, and `-X` overrides it. The response body is printed verbatim on stdout; a non-2xx status prints it on stderr instead and exits with the code from the table above.

Only the path is taken from the argument. A full URL is accepted, but its host is ignored in favour of the one you are logged in to, so a token is never sent somewhere you did not configure.

## Pushing

The first token comes from the server's first start (the printed owner token). With that you can create users on the web (Admin, in the header) or over the API:

```bash
cofferdam user add jeremy
```

This creates the user in `<vault>/vault.json` on the server and prints the token once; only its SHA-256 hash is stored. Then push with the username and the token as the password:

```bash
git push http://127.0.0.1:3000/mycollection/myrepo main
# git prompts: username 'jeremy', password '<token>'
```

Pushing to a repository that does not exist yet creates it, provided the target matches your scope; the collection directory is created as needed, and after the first push HEAD points at the pushed branch. Repositories created this way get `receive.denyNonFastForwards`, `receive.denyDeletes`, and a `receive.maxInputSize` limit of 2 GiB. Anonymous fetch stays open; only pushes require authentication.

### Not typing the token every time

Being asked for the token on every push is the wrong default for a vault you use daily. A token is the password git sends over Basic auth, so the place to keep it is git's own credential store, which `git clone`, `git fetch`, `git push`, and `git lfs` all consult through the same plumbing. `cofferdam login` puts it there:

```bash
cofferdam login https://vault.example.com --helper store   # asks for the token, without echo
```

Afterwards nothing about this vault prompts again, and `cofferdam` commands aimed at it need no arguments either. `cofferdam logout` removes the credential and forgets the vault.

`--helper` says where the token lives, and is recorded for this vault's host alone, so other remotes keep whatever they already use:

| Helper | Where the token goes |
| --- | --- |
| `store` | `~/.git-credentials`, mode 0600, in plain text, the same posture as a GitHub token |
| `cache` | memory only, forgotten after 15 minutes |
| `libsecret` | the desktop keyring, on Linux |
| `osxkeychain` | the login keychain, on macOS |

Pass `--helper` once; later runs of `cofferdam login` reuse whatever is already configured for the host. If nothing is, the command refuses rather than reporting success, because `git credential approve` with no helper configured stores nothing and still exits zero. The token is checked against `/api/whoami` before being stored, so a mistyped one fails immediately rather than at the next push, and it is read back afterwards, which is what catches a helper that is configured but not installed.

Note that this is a client-side arrangement: the vault has no notion of a login, holds no session for git, and is unaware that a credential was stored. Revoking access is still a matter of removing the token from `vault.json`.

Because the token lives in git's store rather than in a cofferdam file, any helper git can use will do, including one of your own that fetches the token from elsewhere:

```bash
git config --global 'credential.https://vault.example.com.helper' \
  '!f(){ echo username=jeremy; echo "password=$(my-secret-tool get cofferdam)"; }; f'
```

Such a helper stores nothing, so `cofferdam login` against it does no more than record the vault and confirm that reading the credential back yields the token it just checked, which is all it needs to do. The trade-off is that this works only where whatever the helper calls works, so editors, GUI git clients, and cron jobs may see no credential at all.

### Importing an existing repository

Importing runs on your machine, not on the server, and `cofferdam import` is what runs it:

```bash
cofferdam import https://github.com/owner/repo mycollection
```

That clones the source into a temporary directory, pushes it at the vault, which creates the repository, and removes the clone again. The source may be an https or ssh git URL, `owner/repo` as shorthand for GitHub, or a directory on this machine, which is the case for a repository that exists only as a local clone. The name comes from the source's last segment; write `mycollection/another-name` to choose another. The collection need not exist: the push creates it, as any push to a new path does.

The source is read with whatever git credentials this machine already has, so a private source works if your own `git clone` of it works, and the push is authorized by the token `cofferdam login` stored. Branches and tags come across. Issues and pull requests do not, and the description is set afterwards in repository settings. A name already taken stops the import before the clone, since a mirror push would replace that repository's branches and tags.

Git LFS objects are not carried over by default, because a mirror push copies the pointer files and not the objects behind them, which leaves the imported files reading as missing. `--lfs` brings them too, and needs `git-lfs` installed:

```bash
cofferdam import https://github.com/owner/repo mycollection --lfs
```

Note that nothing about this happens on the server. A vault that imported on your behalf would need outbound network access, credentials for other services, a disk budget, and work that outlives a request, none of which this project has; doing it from your machine needs none of it, and progress and cancellation come from your terminal. The cost is that the data passes through your machine, and that importing many repositories is a shell loop rather than a form.

The **Import** button on a collection page writes out the same commands, filled in with that collection and this vault's URL, for copying into a terminal. It also carries the two git commands the import is made of, for a machine with no Node on it:

```bash
tmp="$(mktemp -d /tmp/import.XXXXXX)" && \
  git clone --bare https://github.com/owner/repo.git "$tmp" && \
  GIT_ASKPASS= git -C "$tmp" push --mirror https://you@vault.example.com/mycollection/repo && \
  rm -rf "$tmp"
```

The clone is a scratch copy, so it goes to a temporary directory rather than to whatever directory you happen to be standing in, and a fresh one each time means a failed attempt never blocks the next. If you have run `cofferdam login`, the push takes the token from git's credential store and asks nothing; otherwise git asks for a password on the push, and that is your cofferdam token. The `GIT_ASKPASS=` prefix keeps that prompt in the terminal you pasted the command into. Without it, an editor that sets `GIT_ASKPASS` for its integrated terminal, as VS Code does, answers the prompt with a dialog box elsewhere in the window instead; if that dialog goes unnoticed, git prints nothing after the clone and waits, which reads as a hang.

By hand, LFS objects are two more commands from inside the bare clone, before it is deleted:

```bash
git -C "$tmp" lfs fetch --all https://github.com/owner/repo.git
GIT_ASKPASS= git -C "$tmp" lfs push --all https://you@vault.example.com/mycollection/repo
```

`--all` copies every version of every tracked file rather than only the tips, so the history stays checkoutable.

The clone is `--bare` rather than `--mirror` on purpose: mirroring a GitHub repository also copies `refs/pull/*`, which can be thousands of refs.

### Collections

A collection is a directory of repositories, and most of them come into being on the way to something else: creating a repository, importing one, or pushing to a path that does not exist yet all create the collection they land in. For the other order, an empty collection made first and filled later, there is **New collection** on the collections page, and:

```bash
cofferdam collection add mycollection
cofferdam collection list
```

Creating one needs push scope over something inside it. An empty collection is an empty directory, so removing it again is `rmdir` in the vault.

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
cofferdam user add alice --scope 'mycollection/*'      # create with access to one collection
cofferdam user grant alice --scope 'othercollection/*' # extend an existing user
cofferdam user grant alice --admin 'mycollection/*'    # delegate user management for mycollection
cofferdam user list                                    # review who can push where
```

Note that `--scope` on `cofferdam user add` applies only when creating a user; on an existing user the command refuses rather than silently replacing their permissions (run it without `--scope` to mint an additional token).

### JSON API

The CLI is a thin client over a small API, authenticated with `Authorization: Bearer <token>`:

```
GET    /api/whoami              user, scopes, and restriction of the presented token
GET    /api/collections         collections and how many repositories each holds
GET    /api/collections/:name   one collection and the repositories in it
POST   /api/collections         create an empty collection      {name}
GET    /api/users               list users (admin required)
POST   /api/users               create a user or mint a token  {username, scope?, admin?, tokenScope?}
POST   /api/users/:name/grant   extend a user's scopes         {scope?, admin?}
GET    /api/runners             list registered runners (admin required)
POST   /api/runners             register a runner, returning its token once  {name, labels?, allow}
DELETE /api/runners/:name       remove a runner (admin over what it serves)
```

The API accepts only bearer tokens and git accepts only Basic auth; session cookies never authorize either. The two credential presentations stay deliberately distinct.

A runner authenticates with its own token rather than a user's, and the endpoints it uses to take jobs and report on them (`/api/runner/*`) are a protocol between the vault and the runner rather than an interface to program against, so they are not listed here. [Workflows](workflows.md) describes what a runner is and what it does.
