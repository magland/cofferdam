# The JSON API

Every route the vault answers with JSON, what it takes, and what it requires of the caller.

For a shorter introduction aimed at a program rather than a person, see [cofferdam for an agent](agents.md). For the command line over this API, see [The command line](cli.md).

## The rules that hold everywhere

**Authentication is a bearer token and nothing else.** `Authorization: Bearer <token>`. A session cookie never authorizes an API call, and a bearer token never authorizes an HTML form post; git accepts only Basic auth. The three credential presentations stay deliberately distinct, and each is checked in one place.

**There is no anonymous reading.** The web is where anonymous reading lives. Requiring a token on `/api` keeps one rule for the whole surface, and it is the rule to revisit first if a real caller needs otherwise.

**Authorization has three levels.** A read takes any valid token. A write takes push scope over `<collection>/<repo>`, as `git push` does. Renaming a repository, deleting one, removing a user, and changing a vault-wide setting take admin scope, and a vault-wide setting takes admin scope over everything rather than merely some admin scope: a delegated collection administrator should not restyle the whole vault.

**A repository is two path segments,** `/api/repos/<collection>/<repo>`, with the `.git` suffix accepted and ignored.

**Lists come back as a named array,** `{"issues": [...]}` rather than a bare array, so that adding a count or a truncation flag later is not a breaking change. Where a list can be narrowed, the response also carries `total`, which is how many matched before `limit` was applied.

**There is no pagination protocol.** `?limit=` and the server's own caps are what there is. A vault's collections are small and everything is read off disk per request, so a cursor protocol would be machinery with nothing to carry.

**The response objects are the vault's own.** They are the interfaces in `src/issues.ts`, `src/pulls.ts`, `src/releases.ts`, and `src/ci/runs.ts`, unchanged, so a field added to the vault's state appears here without a decision being made about it. Timestamps are ISO 8601 strings.

**Errors are `{"error": "..."}`** with a status that says what kind of failure it was:

| Status | Meaning |
| --- | --- |
| 400 | The request was malformed, or a domain rule refused it |
| 401 | No token, or the token was rejected |
| 403 | The token is valid and not allowed to do this |
| 404 | No such repository, issue, run, file, or ref |
| 409 | It already exists, or someone got there first, or it will not apply |
| 413 | Too large; push it instead, or use Git LFS |
| 429 | Too many failed credential checks, or too many requests. Carries `Retry-After` |
| 503 | The server is busy with other git work. Carries `Retry-After` |

**No version prefix.** Additive change is the compatibility story, the same one the vault's on-disk formats have.

**There is no content negotiation on the HTML routes.** `/demo/proj/tree/main` renders a page whatever the `Accept` header says. The two surfaces authenticate differently, carry different parameters, and have different error shapes; serving both off one route would mean one handler holding two of everything.

## Whoami, collections, users

```
GET    /api/whoami                     the user, scopes, and restriction of this token
GET    /api/collections                collections and how many repositories each holds
GET    /api/collections/:name          one collection and the repositories in it
POST   /api/collections                create an empty one            {name}
DELETE /api/collections/:name          remove an empty one            (admin over the collection)
GET    /api/users                      every user                     (admin)
POST   /api/users                      create a user, or mint a token {username, scope?, admin?, tokenScope?}
POST   /api/users/:name/grant          extend a user's scopes         {scope?, admin?}
GET    /api/users/:name                one user, with their token ids
DELETE /api/users/:name                remove a user                  (requires ?confirm=<name>)
GET    /api/users/:name/tokens         token ids, creation times, scopes
DELETE /api/users/:name/tokens/:id     revoke one token
```

`POST /api/users` returns the token once. Only its SHA-256 hash is stored, so it cannot be recovered afterwards.

A token listing never contains a token or its hash. What it contains is an `id`, which is what revocation takes; a token minted before ids existed is identified by the first eight characters of its hash instead, so an existing vault needs no migration.

A user may read their own record and their own token ids without admin scope. Removing a user refuses to remove the caller: unlike revoking one token, that cannot be undone by minting another. Revoking the token currently in use **is** allowed, and the response says `wasThisToken: true` rather than refusing; locking yourself out is your business, and `vault.json` remains hand-editable.

## Vault settings

```
GET    /api/config                     theme, CI retention, sites, network, and limits
                                                                      (admin over everything)
PATCH  /api/config                     {theme?, ci?, sites?}          (admin over everything)
```

Both take admin scope over the whole vault, not merely some admin scope: a delegated collection administrator should not read or change a vault-wide setting.

`theme`, `ci`, and `sites` are writable. Every reader of them consults `config.json` per request, so a change is in effect on the next one and no restart is involved. `sites` takes a `host` string, and `""` puts sites back on the forge's own hostname under the sandbox; a value that is not a plausible hostname is refused with 400 rather than stored. See [Sites](sites.md) for what a sites host does, and [Deploying a vault](deploying.md#a-hostname-for-each-site) for the DNS and certificates it needs.

`network.trustProxy` and the `limits` block are readable and not writable. They are read once when the server starts (see [Deploying a vault](deploying.md)), so a route that changed them would report a change the running server had not made. Edit `config.json` in the vault and restart.

## Repositories

```
GET    /api/repos                                  every repository in the vault, flat
GET    /api/repos/:c/:r                            one repository: description, default branch,
                                                   counts, fork parent, whether it has a site
POST   /api/repos                                  create   {collection, name, description?, initReadme?}
PATCH  /api/repos/:c/:r                            settings {description?, defaultBranch?}
POST   /api/repos/:c/:r/fork                       fork     {collection, name?}
                                                   (push on the source, and on where it lands)
POST   /api/repos/:c/:r/rename                     rename   {name?, collection?}          (admin)
DELETE /api/repos/:c/:r                            delete   (requires ?confirm=<c>/<r>)   (admin)
GET    /api/repos/:c/:r/branches                   branches, with the default branch named
POST   /api/repos/:c/:r/branches                   create   {name, from}
DELETE /api/repos/:c/:r/branches/*                 delete a branch
GET    /api/repos/:c/:r/tags                       tags
POST   /api/repos/:c/:r/tags                       create   {name, at}
DELETE /api/repos/:c/:r/tags/*                     delete a tag
GET    /api/repos/:c/:r/site                       whether a site exists, its file count, when it changed
```

`GET /api/repos/:c/:r` also carries `canPush`, so a caller need not discover what it may do by being refused.

Forking takes push scope over the source as well as over the collection the fork lands in, which is stricter than the web's reading of the same operation and stricter than GitHub's. A read-only token is refused. This is the rule to revisit first if forking is ever meant to be something a reader can do.

Branch and tag deletion take the name as a wildcard path segment, because a ref name may contain slashes and `release/1.0` does not fit in one.

`?confirm=` on delete is the API's equivalent of the web's typed confirmation. It costs nothing and it makes an accidental `DELETE` from a loop over a listing impossible.

The site route is read only. Publishing a site is a workflow's job or a file copy into the vault; an upload path here would be a second way to write the one directory whose contents are served to browsers (see [Sites](sites.md)).

## Contents and history

```
GET  /api/repos/:c/:r/tree?ref=&commits=1       the root directory listing
GET  /api/repos/:c/:r/tree/*?ref=&commits=1     a directory listing; commits=1 adds the last
                                                commit per entry, at one git log each
GET  /api/repos/:c/:r/contents/*?ref=           one file: metadata plus text, base64 when binary,
                                                or a note when it is a Git LFS pointer
GET  /api/repos/:c/:r/raw/*?ref=                the bytes, sandboxed as the web raw route is
GET  /api/repos/:c/:r/commits?ref=&path=&limit= commits, newest first
GET  /api/repos/:c/:r/commits/:sha              one commit
GET  /api/repos/:c/:r/commits/:sha/patch        the patch, as text/plain
GET  /api/repos/:c/:r/compare/*                 <base>...<head>: counts, commits, and the diff
GET  /api/repos/:c/:r/blame/*?ref=              blame lines
GET  /api/repos/:c/:r/search?q=&ref=            literal search hits
GET  /api/repos/:c/:r/paths?ref=&limit=         every path in the tree
GET  /api/repos/:c/:r/contributors?ref=
GET  /api/repos/:c/:r/languages?ref=
PUT  /api/repos/:c/:r/contents/*                create or replace a file, committing
DELETE /api/repos/:c/:r/contents/*              delete a file, committing
POST /api/repos/:c/:r/commits                   several files as one commit
```

`?ref=` accepts a branch, a tag, or a commit id, never an arbitrary revision expression, and defaults to the repository's default branch.

`GET .../contents/*` carries `commit`, the commit the ref was at. That is the value to hand back as `expectedSha` on a write.

A file over 1 MiB is refused with 413 rather than returned; fetch it from `/raw/` or from a clone. The search and tree routes are behind the same concurrency gates the web routes are, so they may answer 503 with `Retry-After` when the server is already busy with git (see [Deploying a vault](deploying.md#limits)).

### Writing a file

```json
{
  "branch": "main",
  "message": "Add a thing",
  "content": "text of the file",
  "encoding": "utf-8 | base64",
  "expectedSha": "<the commit the caller last saw, optional>",
  "newBranch": "<optional; created at expectedSha and committed to instead>"
}
```

`PUT` creates or replaces, so a caller that has read a file and means to change it does not have to know which of the two it is doing; the response says `created`.

`expectedSha` is optimistic concurrency and it is what a caller that reads, thinks, and then writes wants. Given one, a branch that has moved since is 409 rather than a silent overwrite. A sha that names no commit in this repository is also 409, with a message saying to read the file again. Absent, the write is unconditional.

A path holding a Git LFS pointer is refused: the repository holds a pointer and not the file, so writing text over it would orphan the object.

The multi-file shape:

```json
{
  "branch": "main",
  "message": "Change three things",
  "expectedSha": "...",
  "newBranch": null,
  "files": [
    { "path": "a.txt", "content": "..." },
    { "path": "b.png", "content": "<base64>", "encoding": "base64" },
    { "path": "old.txt", "delete": true }
  ]
}
```

One commit, because three files changed as one logical edit should not be three commits recording states nobody chose. A single file is capped at 1 MiB and the whole body at 25 MiB; anything larger belongs in a push, or in Git LFS.

**Every write here fires the same CI push event a `git push` fires.** A commit made over the API is a push as far as workflows are concerned, and the two interfaces would otherwise diverge silently.

## Issues

```
GET    /api/repos/:c/:r/issues?state=&label=&author=&sort=&q=&limit=
POST   /api/repos/:c/:r/issues                  {title, body?, labels?}
GET    /api/repos/:c/:r/issues/:n               the issue with its comments
PATCH  /api/repos/:c/:r/issues/:n               {title?, body?, labels?}
POST   /api/repos/:c/:r/issues/:n/comments      {body}
POST   /api/repos/:c/:r/issues/:n/state         {state: "open" | "closed"}
GET    /api/repos/:c/:r/issues/labels           labels and authors in use, with counts
```

`state` is `open` (the default), `closed`, or `all`. `sort` is `newest`, `oldest`, `updated`, or `comments`. `q` matches the title, the body, or a label.

`labels` on `PATCH` replaces the whole set. Numbers are per repository and never reused.

**The author is the token's user.** No `author` field is read from a body, on any route, ever.

## Pull requests

```
GET    /api/repos/:c/:r/pulls?state=&limit=
POST   /api/repos/:c/:r/pulls                   {title, body?, base, head}
GET    /api/repos/:c/:r/pulls/:n                the pull request with its comments
PATCH  /api/repos/:c/:r/pulls/:n                {title?, body?}
POST   /api/repos/:c/:r/pulls/:n/comments       {body}
POST   /api/repos/:c/:r/pulls/:n/state          {state: "open" | "closed"}
GET    /api/repos/:c/:r/pulls/:n/diff           the diff, as compare returns it
GET    /api/repos/:c/:r/pulls/:n/commits        the commits between base and head
GET    /api/repos/:c/:r/pulls/:n/merge          mergeability, without merging
POST   /api/repos/:c/:r/pulls/:n/merge          {method?, message?, deleteBranch?}
POST   /api/repos/:c/:r/pulls/:n/delete-branch  delete the head branch after the fact
```

`state` is `open` (the default), `closed`, `merged`, or `all`. Both `base` and `head` must be branches the repository has.

`GET .../merge` is the useful one: it answers whether the merge would apply without writing anything, which is the read to make before the write. It reports `mergeable`, and on a conflict the paths that conflict.

`POST .../merge` takes `method` of `merge` (the default, keeping both parents) or `squash`. A conflict is **409 with the conflicting paths in the body**, not a 400 and not a 500. A pull request that is not open is also 409: to a caller deciding whether to retry, "someone already merged this" is the same answer as "someone got there first".

Merging takes push scope over the repository. Authorship is not enough, as it is for closing, because merging moves a branch.

Neither the diff nor the commit list is ever stored. Both are questions for git, answered from base and head at the moment they are asked, so a stored copy could only ever be a stale one.

## Releases

```
GET    /api/repos/:c/:r/releases
GET    /api/repos/:c/:r/releases/:tag           (tag percent-encoded)
PUT    /api/repos/:c/:r/releases/:tag           create or update {name?, body?, prerelease?}
DELETE /api/repos/:c/:r/releases/:tag
```

`PUT` rather than `POST`, because a release is keyed by its tag and the file written is the same either way. Creating and editing being one call removes a whole class of "already exists, retry as an edit" logic from the caller; a field left out keeps whatever is there.

The tag has to exist in the repository first, which is what the web form checks: notes for a tag nobody can check out are notes about nothing. `DELETE` removes the notes and keeps the tag, and says so.

**There are no release assets.** A release's downloads are the archive routes, so there is nothing to upload.

## Workflows and runs

```
GET  /api/repos/:c/:r/workflows?ref=            workflows at a ref, with their dispatch inputs
GET  /api/repos/:c/:r/runs?limit=&status=       runs, newest first
GET  /api/repos/:c/:r/runs/:n                   one run with its jobs and step states
GET  /api/repos/:c/:r/runs/:n/jobs/:job         one job
GET  /api/repos/:c/:r/runs/:n/jobs/:job/log     the log; ?tail=<n>, ?format=text|ndjson
GET  /api/repos/:c/:r/runs/:n/artifacts
GET  /api/repos/:c/:r/runs/:n/artifacts/:name   the tar
POST /api/repos/:c/:r/runs/:n/cancel
POST /api/repos/:c/:r/runs/:n/rerun
POST /api/repos/:c/:r/dispatches                {workflow, ref?, inputs?}
```

`GET .../runs/:n` includes the jobs with their step states, because "which step failed" is the next question after "did it fail" and a request per job to answer it would be a poor trade.

`?tail=` defaults to 200 and is not a convenience. A job log can be large and is capped by the server as it is written; a caller diagnosing a failure wants the end of it, and handing over the whole thing spends its attention on the part that worked. `?tail=0` asks for all of it. The response distinguishes the two kinds of truncation, which are not the same thing: `truncated` means tail kept only the end, and `capped` means the server stopped recording. A job that failed in the planner has no log at all, only `error`.

Cancelling a run that is not in progress is 409. Dispatching requires the workflow to have a `workflow_dispatch` trigger and the ref to be a branch the repository has.

**There is nothing behind `gh pr checks`.** cofferdam has no check suites and no commit statuses. The nearest answer is the runs whose sha matches the pull request's head, which is exactly what `cofferdam pr checks` computes.

## Runners

Registering the runners a vault will hand jobs to. Note the plural: these are `/api/runners`, an ordinary admin surface authenticated by a user's token, and are not the runner protocol below.

```
GET    /api/runners                    registered runners, their labels and allow globs   (admin)
POST   /api/runners                    register one   {name, labels?, allow}              (admin over allow)
DELETE /api/runners/:name              remove one                                         (admin over its allow)
```

`POST` returns `{name, token, labels, allow}`, and the token once: it is what `cofferdam runner run --token` presents, and only its hash is kept. `allow` is a list of globs saying which repositories the runner serves and is required, since a runner with no allow list could take no job. `labels` defaults to `["ubuntu-latest"]`.

Registration takes admin scope over exactly the repositories in `allow`, rather than admin scope in general, because a runner executes repository-controlled code on its own machine: granting one a repository is granting that repository's authors the runner. Removing a runner takes admin scope over the allow list it was registered with. A name that is already registered is 409.

## The runner protocol

`/api/runner/*`, singular, is a private protocol between a vault and the runners it hands jobs to, authenticated by a runner token rather than a user's. It is not an interface to program against and is not documented here. [Workflows](workflows.md) describes what a runner is and does.

## Rate limits

A read is not rate limited by count, but three things bound what the server will do:

- **Concurrency gates** on the routes that spawn git. Beyond one, a request waits briefly and is then refused with `503` and `Retry-After`.
- **Failed credential checks,** per address and per address-and-username. A working token is never throttled however often it is used. A refusal is `429` with `Retry-After`.
- **A coarse per-address ceiling** on everything not exempt. `/api/runner/*` is exempt, since a runner polls continuously and legitimately.

The numbers, and how to change them, are in [Deploying a vault](deploying.md#limits).
