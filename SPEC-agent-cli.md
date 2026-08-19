# Spec: an agent-usable command line over the whole vault

This is an implementation handoff document, not user documentation. It describes a change to
be made to cofferdam; delete it once the change has landed and `docs/cli.md`, `docs/api.md`
(new), and `docs/agents.md` (new) describe the result.

## The problem

An AI agent working on a GitHub repository does not use the web interface. It uses `gh`,
because `gh` exposes essentially everything the web interface can do, prints JSON on request,
never prompts, and has an escape hatch (`gh api`) for whatever the typed commands left out.
The agent can read an issue, open a pull request, watch a run, and download a log without a
browser and without a human in the loop.

cofferdam is not usable that way. The CLI (`src/index.ts:24-140`) has ten commands:
`serve`, `import`, `collection add|list`, `user add|grant|list`, `whoami`, `login`, `logout`,
`deploy fly|show|destroy`, and `runner add|run|list|remove`. The JSON API underneath it
(`src/api.ts`, plus the runner endpoints in `src/ci/api.ts`) has seven routes covering
`whoami`, collections, and users. Every other capability the vault has, and there are many,
exists only as HTML: repositories (`src/webops.ts:284-1062`), issues
(`src/issueweb.ts:349-535`), pull requests (`src/pullweb.ts:361-650`), releases
(`src/releases.ts:306-460`), workflow runs (`src/ci/web.ts:87-340`), browsing
(`src/browse.ts`), search and file finding (`src/find.ts`), and comparison
(`src/compare.ts`).

Those HTML routes are authorized by a session cookie and a CSRF field
(`src/session.ts:146-159`), which the API deliberately does not accept: "The API accepts only
bearer tokens and git accepts only Basic auth; session cookies never authorize either"
(`docs/cli.md`). So an agent holding a perfectly good token cannot create an issue, cannot
merge a pull request, cannot read a workflow log, and cannot even list the files in a
repository, other than by scraping HTML or by cloning. The README roadmap already names the
gap: "JSON responses on the read routes via content negotiation, and UI operations mirrored
into the API."

The domain logic is not the obstacle. It is already factored into modules that know nothing
about HTTP: `src/ops.ts` (repositories, branches, tags, commits, merges), `src/issues.ts`,
`src/pulls.ts`, `src/releases.ts`, `src/git.ts` (`GitRepo`, with tree, blob, log, diff, blame,
search, archive), and `src/ci/engine.ts` (dispatch, cancel, rerun, run and job records). What
is missing is a JSON transport in front of them and a CLI in front of that.

## What this change delivers

- **A JSON API that covers every operation the web interface offers,** under `/api`,
  bearer-token only, sharing the same authorization checks and the same domain functions the
  web handlers use.
- **A CLI over it,** organized the way `gh` is: `repo`, `issue`, `pr`, `release`, `run`,
  `workflow`, `file`, `search`, `api`. Every read command takes `--json`; no command ever
  prompts when given its arguments.
- **A generic `cofferdam api` command,** so a capability that has no typed command is still
  one line away, and so this spec's own gaps do not block an agent.
- **`docs/agents.md`,** short enough to paste into an agent's context, describing the command
  set, the JSON shapes, and the exit codes.

The three parts are independently useful and should land in the order given in
[Phasing](#phasing). Part 1 alone (API for issues, pull requests, and repository reads, plus
`cofferdam api`) already makes an agent functional.

### Not in scope

- Anything the vault does not already do. This change exposes existing behaviour; it adds no
  new forge features. In particular there are no reactions, no review threads, no assignees,
  no milestones, no projects, no notifications, and no webhooks, because cofferdam has none of
  those. Where `gh` has a command for one of them, this spec omits it rather than inventing a
  half-version.
- Git data mutation beyond what `src/ops.ts` already implements. No force-push, no ref
  rewriting, no history editing over the API.
- Pagination as a protocol. A vault's collections are small and everything is read off disk
  per request; `--limit` and server-side caps are enough, and a cursor protocol would be
  machinery with nothing to carry. Revisit if a vault ever holds tens of thousands of issues.
- Content negotiation on the HTML routes (`Accept: application/json` on `/demo/proj/tree/...`).
  See [Why explicit routes](#why-explicit-api-routes-rather-than-content-negotiation).
- Changing how git, LFS, or the runner protocol authenticate. `/api/runner/*` stays a private
  protocol between vault and runner and is not part of the public surface.
- Shell completions, a pager, colour, and terminal width detection. An agent wants none of
  them, and a human has the web interface.

## Design decisions

### Why explicit `/api` routes rather than content negotiation

The roadmap line suggests answering the existing HTML routes with JSON when the client asks
for it. This spec does not do that, for four reasons:

1. **The two surfaces authenticate differently.** HTML routes read a session cookie; API
   routes read a bearer token. Serving both off one route means one handler holding two auth
   paths, which is exactly the confusion `docs/cli.md` promises the project avoids.
2. **The HTML routes carry UI-shaped parameters.** `src/issueweb.ts:349` takes `state`,
   `label`, `author`, `sort`, and `q` and returns a rendered page with filter chips;
   `src/browse.ts:155` returns a tree with last-commit-per-entry, which costs one `git log`
   per entry (`src/git.ts:240`). An API caller usually wants less than that, and sometimes
   more. Coupling the two makes both harder to change.
3. **Caching and error shape differ.** An HTML 404 renders `views.errorPage`; an API 404 must
   be `{"error": "..."}`. Branching on `Accept` inside every handler is worse than two
   registrations calling one function.
4. **A stable API is a promise.** Route paths under `/api` can be documented and kept; the
   HTML paths are free to change with the interface.

The cost is duplication of routing, roughly one thin handler per operation. The mitigation is
that both handlers call the same domain function and the same authorization helper, so the
duplication is transport only. Where logic currently lives inside a web handler, extract it
(see [Extraction work](#extraction-work)).

No version prefix. The existing routes are `/api/whoami`, `/api/collections`, `/api/users`,
and adding `/api/v1/...` beside them would leave the surface split forever. Additive change is
the compatibility story, the same one the vault's on-disk formats already have.

### Repository addressing

Everywhere in the API a repository is two path segments, `/api/repos/:collection/:repo`, with
`:repo` accepted with or without the `.git` suffix and normalized through
`displayName` (`src/scan.ts:77`), which is how `findRepo` (`src/scan.ts:108`) already behaves.

On the CLI a repository is `collection/repo` as a positional argument or `--repo
collection/repo`. When neither is given, resolve it from the git remotes of the current
directory: find a remote URL whose origin matches the logged-in vault host, and take the last
two path segments. This matters more for agents than it looks, because an agent working inside
a clone should not have to be told twice where it is. Resolution order:

1. `--repo`, or the positional argument where the command takes one.
2. `COFFERDAM_REPO`.
3. The git remote in the current directory that points at the vault host, preferring `origin`.
4. Otherwise fail with a message naming all three options.

### Output contract

Every read command prints a human table by default and, with `--json`, a single JSON value on
stdout and nothing else. Rules that the implementation must hold to, because agents depend on
them more than humans do:

- `--json` output goes to stdout; every diagnostic goes to stderr. A caller doing
  `cofferdam issue list --json | jq` must never have to filter.
- Field names and shapes come from the interfaces already in the source: `IssueSummary` and
  `Issue` (`src/issues.ts:32-55`), `PullSummary` and `Pull` (`src/pulls.ts:26-54`), `Release`
  (`src/releases.ts:33-45`), `RunRecord` and `JobRecord` (`src/ci/runs.ts:36-100`). Do not
  rename fields for the API. Timestamps are already ISO 8601 strings.
- List commands return a JSON object with one named array (`{"issues": [...]}`), not a bare
  array, so a later addition of a count or a truncation flag is not a breaking change.
- `--json <fields>` may take a comma-separated field list, as `gh` does, filtering the
  objects to those keys. This is worth having: it lets an agent ask for `number,title,state`
  and keep a listing of 200 issues small. Unknown field names are an error naming the valid
  ones.
- Errors with `--json` still print `{"error": "..."}` on stderr and exit non-zero, so a
  caller that parses stderr on failure can.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Generic failure, including a 4xx or 5xx from the vault |
| 2 | Usage error: unknown command, unknown flag, missing argument |
| 3 | Authentication failure: no token, or the vault rejected it (HTTP 401) |
| 4 | Not found: the vault answered 404 for the addressed resource |
| 5 | Conflict: the vault answered 409, or an operation is refused because of state (a merge
      conflict, an existing name, a stale expected sha) |

Distinct codes for 404 and 409 are the ones that pay for themselves, since "does this exist"
and "did someone else get there first" are the two questions a retrying agent asks. Today
every failure is exit 1 (`src/cli-api.ts:53-56`), so this is a change in `apiFailed`.

### No prompting, ever, when arguments are given

`promptToken` (`src/index.ts:363`) is the only interactive path today and it already refuses
when stdin is not a TTY. Keep that, and add:

- `--token-stdin`, reading the token from stdin, so a token never appears in argv or shell
  history. `--token` stays, since it is convenient and already documented.
- `COFFERDAM_HOST` and `COFFERDAM_TOKEN`, honoured by every command that talks to a vault,
  with precedence `--host`/`--token` > environment > `login.json` and git's credential store.
- `--yes` on every destructive command (`repo delete`, `release delete`, `branch delete`,
  `tag delete`, `user token revoke`), refusing without it rather than prompting.
- `--body-file <path>` and `--body-file -` on every command that takes a body, alongside
  `--body`. An issue body is frequently longer than a shell argument should be.

Note that the environment variables reverse a stance `docs/cli.md` states plainly: "There is
one way to configure the CLI and it is `cofferdam login`: nothing to set in the environment."
That stance is right for a human on a laptop and wrong for an agent in a container, which has
no keyring, may have no writable home directory, and gets its secrets as environment
variables. The runner already concedes the point with `COFFERDAM_RUNNER_TOKEN`. Update that
paragraph in `docs/cli.md` rather than leaving the documentation contradicting the code.

## The API

Every route below requires `Authorization: Bearer <token>` and is registered with the
`requireApiAuth` helper that `src/api.ts:31-49` already has. Read routes require a valid token
but no scope, matching the existing `/api/collections`. Write routes require push scope over
`collection/repo` via `canPush` (`src/vault.ts:161`); admin routes require `canAdmin`
(`src/vault.ts:185`).

Anonymous reads are deliberately not offered on `/api`. The web is where anonymous reading
lives, and requiring a token on the API keeps one rule for the whole surface. Revisit only if
a real caller needs it.

New source files, mirroring the existing split so no file grows unmanageable:

| File | Contents |
| --- | --- |
| `src/api/auth.ts` | `requireApiAuth`, `requirePush`, `requireAdmin`, `apiError`, `loadApiRepo`, moved out of `src/api.ts` |
| `src/api/repos.ts` | repositories, branches, tags, settings, forks |
| `src/api/contents.ts` | tree, blob, raw, commits, diff, blame, search, find, contributors, languages, archive |
| `src/api/issues.ts` | issues and their comments |
| `src/api/pulls.ts` | pull requests, merge preview, merge |
| `src/api/releases.ts` | releases |
| `src/api/ci.ts` | workflows, runs, jobs, logs, artifacts, dispatch, cancel, rerun |
| `src/api/admin.ts` | users, tokens, config; existing collection and user routes move here |

`src/api.ts` becomes a `registerApi` that calls each of these, keeping `createApp`
(`src/server.ts:102`) unchanged in shape. Registration must stay before the generic
`/:collection` browse routes, which it already is.

### Repositories

```
GET    /api/repos                                  every repository in the vault, flat
GET    /api/repos/:collection/:repo                one repository: description, default branch,
                                                   counts, fork parent, whether it has a site
POST   /api/repos                                  create        {collection, name, description?, initReadme?}
POST   /api/repos/:collection/:repo/fork           fork          {collection, name?}
PATCH  /api/repos/:collection/:repo                settings      {description?, defaultBranch?}
POST   /api/repos/:collection/:repo/rename         rename        {name, collection?}
DELETE /api/repos/:collection/:repo                delete        (requires ?confirm=<collection>/<repo>)
GET    /api/repos/:collection/:repo/branches       branches with sha and last commit
POST   /api/repos/:collection/:repo/branches       create        {name, from}
DELETE /api/repos/:collection/:repo/branches/*     delete a branch
GET    /api/repos/:collection/:repo/tags           tags
POST   /api/repos/:collection/:repo/tags           create        {name, at}
DELETE /api/repos/:collection/:repo/tags/*         delete a tag
```

These map onto `ops.createRepo`, `ops.forkRepo`, `ops.setDescription`,
`ops.setDefaultBranch`, `ops.renameRepo`, `ops.deleteRepo`, `ops.createBranch`,
`ops.deleteBranch`, `ops.createTag`, `ops.deleteTag` (`src/ops.ts:48-635`), and on
`GitRepo.listRefs` / `defaultBranch` (`src/git.ts:139-157`).

`OpError` (`src/ops.ts:17`) already carries a `kind` of `invalid | notfound | exists |
conflict | nochange`. Map it once, in a shared helper, rather than per route: `invalid` to
400, `notfound` to 404, `exists` and `conflict` to 409, `nochange` to 200 with a
`{"changed": false}` body. `src/api.ts:100-109` does this ad hoc today for one route.

The `?confirm=` requirement on delete is the API's equivalent of the web's typed
confirmation (`src/webops.ts:1007`). It costs nothing and it makes an accidental
`DELETE` from a loop over a listing impossible.

Branch and tag deletion take the name as a wildcard path segment because a ref name may
contain slashes; follow the pattern in `src/find.ts:43` and validate with `isValidRefName`
(`src/git.ts:112`).

### Contents and history

```
GET  /api/repos/:c/:r/tree/*?ref=              directory listing at a ref; ?commits=1 adds the
                                               last commit per entry (expensive, off by default)
GET  /api/repos/:c/:r/contents/*?ref=          one file: metadata plus text, or base64 when binary,
                                               or a pointer note when it is an LFS pointer
GET  /api/repos/:c/:r/raw/*?ref=               the bytes, as the existing raw route serves them
GET  /api/repos/:c/:r/commits?ref=&path=&limit= commit list
GET  /api/repos/:c/:r/commits/:sha             one commit with its diff summary
GET  /api/repos/:c/:r/commits/:sha/patch       the patch, text/plain
GET  /api/repos/:c/:r/compare/:base...:head    ahead/behind counts, commits, and the diff
GET  /api/repos/:c/:r/blame/*?ref=             blame lines
GET  /api/repos/:c/:r/search?q=&ref=           literal search hits
GET  /api/repos/:c/:r/paths?ref=&limit=        the file list the finder uses
GET  /api/repos/:c/:r/contributors?ref=
GET  /api/repos/:c/:r/languages
GET  /api/repos/:c/:r/archive?ref=&format=     tar.gz or zip, streamed
PUT  /api/repos/:c/:r/contents/*               create or update a file, committing
DELETE /api/repos/:c/:r/contents/*             delete a file, committing
```

The write shape, matching what `src/webops.ts:449-528` and `:649-702` accept:

```json
{
  "branch": "main",
  "message": "Add a thing",
  "content": "text of the file",
  "encoding": "utf-8 | base64",
  "expectedSha": "<blob or commit sha the caller last saw, optional>",
  "newBranch": "optional; created at expectedSha and committed to instead"
}
```

`expectedSha` is the API face of the stale-edit conflict the editor already implements
(`scripts/smoke.sh:220` asserts a 409). Honour it: an agent that reads, thinks, and writes is
exactly the caller that needs it. When absent, the write is unconditional.

For files, `MAX_EDIT_SIZE` (1 MiB, `src/webops.ts:39`) governs a single file and the API
should reuse the constant. Multi-file commits are worth having, since an agent frequently
changes three files as one logical edit, and `ops.commitFiles` (`src/ops.ts:190`) already
does it:

```
POST /api/repos/:c/:r/commits    {branch, message, expectedSha?, newBranch?,
                                  files: [{path, content, encoding} | {path, delete: true}]}
```

Cap the total body at `MAX_UPLOAD_SIZE` (25 MiB, `src/webops.ts:43`) as the upload route
does, and say plainly in the docs that anything larger belongs in a push or in Git LFS.

Both write paths must fire the CI push event the web handlers fire, `firePush`
(`src/webops.ts:95-110`). A commit made over the API is a push as far as workflows are
concerned, and forgetting this would be a silent, confusing divergence between the interfaces.

### Issues

```
GET    /api/repos/:c/:r/issues?state=&label=&author=&sort=&q=&limit=
POST   /api/repos/:c/:r/issues                  {title, body?, labels?}
GET    /api/repos/:c/:r/issues/:n               the issue with its comments
PATCH  /api/repos/:c/:r/issues/:n               {title?, body?, labels?}
POST   /api/repos/:c/:r/issues/:n/comments      {body}
POST   /api/repos/:c/:r/issues/:n/state         {state: "open" | "closed"}
GET    /api/repos/:c/:r/issues/labels           labels in use, with counts
```

`listIssues`, `selectIssues`, `labelsInUse`, `authorsInUse`, `readIssue`, `createIssue`,
`addComment`, `setIssueState`, `editIssue` (`src/issues.ts:155-460`) cover all of it. The
query parameters are the ones `src/issueweb.ts:349` already parses, and `ISSUE_SORTS`
(`src/issues.ts:186`) is the accepted set of `sort` values. `MAX_TITLE`, `MAX_BODY`, and
`MAX_LABELS` (`src/issues.ts:57-59`) are enforced by the domain functions already; the API
must turn the resulting `OpError` into 400 rather than 500.

Who the author is: the web takes it from the session (`viewer.auth.username`). The API takes
it from `auth.username` on the bearer token. No `author` field is accepted from the body, on
any route, ever.

### Pull requests

```
GET    /api/repos/:c/:r/pulls?state=&limit=
POST   /api/repos/:c/:r/pulls                  {title, body?, base, head}
GET    /api/repos/:c/:r/pulls/:n               the pull request with its comments
PATCH  /api/repos/:c/:r/pulls/:n               {title?, body?}
POST   /api/repos/:c/:r/pulls/:n/comments      {body}
POST   /api/repos/:c/:r/pulls/:n/state         {state: "open" | "closed"}
GET    /api/repos/:c/:r/pulls/:n/diff          the diff, as compare returns it
GET    /api/repos/:c/:r/pulls/:n/commits       the commits between base and head
GET    /api/repos/:c/:r/pulls/:n/merge         mergeability, without merging
POST   /api/repos/:c/:r/pulls/:n/merge         {method: "merge" | "squash", message?,
                                                deleteBranch?: boolean}
```

`GET .../merge` is `ops.previewMerge` (`src/ops.ts:414`), and it is the single most useful
addition for an agent: it answers "will this apply" before anything is written. `POST` is
`ops.mergeBranch` (`src/ops.ts:430`) followed by `pulls.recordMerge` (`src/pulls.ts:347`) and,
when asked, `ops.deleteBranch`, which is the sequence `src/pullweb.ts:590-650` performs today.
That sequence must be extracted rather than reimplemented (see below). A conflict is 409 with
the conflicting paths in the body, not a 400 and not a 500.

`deleteBranch` folds the separate web route (`src/pullweb.ts:557`) into the merge call, and
should also be reachable on its own for the after-the-fact case:

```
POST /api/repos/:c/:r/pulls/:n/delete-branch
```

### Releases

```
GET    /api/repos/:c/:r/releases
GET    /api/repos/:c/:r/releases/:tag           (tag percent-encoded)
PUT    /api/repos/:c/:r/releases/:tag           create or update  {name?, body?, prerelease?}
DELETE /api/repos/:c/:r/releases/:tag
```

`listReleases`, `readRelease`, `saveRelease`, `deleteRelease` (`src/releases.ts:79-135`).
`PUT` rather than `POST` because a release is keyed by its tag and the file is one
`saveRelease` either way; creating and editing being the same call removes a whole class of
"already exists, retry as an edit" logic from the caller. The tag must already exist in the
repository, which is what the web form checks.

A release's downloads are the archive routes, so there is nothing to upload and no asset
endpoints. Say so in the docs, because an agent that knows `gh release upload` will look.

### Workflows and runs

```
GET  /api/repos/:c/:r/workflows?ref=            workflows at a ref, with their dispatch inputs
GET  /api/repos/:c/:r/runs?limit=&status=       runs, newest first
GET  /api/repos/:c/:r/runs/:n                   one run with its jobs and step states
GET  /api/repos/:c/:r/runs/:n/jobs/:job         one job
GET  /api/repos/:c/:r/runs/:n/jobs/:job/log     the log; ?tail=<n> for the last n lines,
                                                ?format=text|ndjson
GET  /api/repos/:c/:r/runs/:n/artifacts
GET  /api/repos/:c/:r/runs/:n/artifacts/:name   the tar, streamed
POST /api/repos/:c/:r/runs/:n/cancel
POST /api/repos/:c/:r/runs/:n/rerun
POST /api/repos/:c/:r/dispatches                {workflow, ref, inputs?}
```

`listWorkflowsAt` (`src/ci/engine.ts:1108`), `engine.handleDispatch` (`:298`),
`engine.cancelRun` (`:1006`), `engine.rerun` (`:1015`), `engine.runOf` (`:1095`),
`engine.jobOf` (`:1089`), and the run and log readers in `src/ci/runs.ts`. The engine instance
is constructed in `src/server.ts:97` and already passed to `registerCiApi`, so
`src/api/ci.ts` takes it the same way.

`?tail=` is not a convenience. A job log can be large and is capped by the server
(`logCapped`, `src/ci/runs.ts:63`); an agent diagnosing a failure wants the end of it, and
handing it the whole thing wastes its context. Default `?tail=200` when the parameter is
absent and the format is text, and say so in the response as `{"truncated": true}`. Full logs
remain available with `?tail=0`.

Note the divergence to document: cofferdam has no equivalent of a check suite or a commit
status, so there is nothing behind `gh pr checks`. The nearest answer is the runs whose sha
matches the pull request head, and `cofferdam pr checks` should be implemented exactly that
way, with the docs saying that is what it means.

### Sites

```
GET  /api/repos/:c/:r/site        whether a site exists, when it was last written, its entry count
```

Read only. Publishing a site is a workflow's job (`src/ci/api.ts:407`) or a file copy into the
vault, and adding an upload path here would create a second way to write the one directory
whose contents are served to browsers. The site isolation work described in
`SPEC-site-isolation.md` changes how sites are served and does not interact with this spec;
neither blocks the other.

### Administration

Existing routes stay where they are, with the collection and user handlers moved into
`src/api/admin.ts` unchanged. Added:

```
DELETE /api/collections/:name              remove an empty collection
GET    /api/users/:name                    one user: scopes and token metadata
DELETE /api/users/:name                    remove a user
GET    /api/users/:name/tokens             token ids, creation times, scopes; never the token
DELETE /api/users/:name/tokens/:id         revoke one token
GET    /api/config                         theme and CI retention
PATCH  /api/config                         {theme?, ci?}
```

Token revocation needs a stable per-token identifier, which `TokenRecord`
(`src/vault.ts:8-12`) does not have: it holds a hash and an optional scope. Add an `id` (a
short random string) when a token is minted, and treat a record without one as identified by
the first eight characters of its hash so that existing vaults keep working without migration.
Revoking the token currently in use is allowed and should be reported plainly rather than
refused, since locking yourself out is your business and `vault.json` remains hand-editable.

Deleting a user is new behaviour rather than an exposure of existing behaviour, and it is the
one place this spec adds a capability. It is included because a vault an agent administers
accumulates users, and the alternative is editing `vault.json` by hand. If the implementer
prefers to keep the change purely additive-in-transport, drop `DELETE /api/users/:name` and
say in the docs that removing a user is a hand edit.

## The CLI

Names follow `gh` wherever the concept matches, because that is the point: an agent that
knows `gh` should guess right. Every command accepts `--host`, `--token`, `--token-stdin`,
`--repo`, and `--json`.

```
cofferdam repo list [<collection>] [--json]
cofferdam repo view [<repo>] [--json]
cofferdam repo create <collection>/<name> [--description <d>] [--readme]
cofferdam repo fork <repo> <collection>[/<name>]
cofferdam repo edit [<repo>] [--description <d>] [--default-branch <b>]
cofferdam repo rename <repo> <new-name>
cofferdam repo delete <repo> --yes
cofferdam repo clone <repo> [<dir>]                 git clone with the vault URL filled in

cofferdam branch list|create|delete
cofferdam tag list|create|delete

cofferdam file list [<path>] [--ref <r>] [--json]
cofferdam file view <path> [--ref <r>] [--raw]
cofferdam file write <path> --body-file <f> [--message <m>] [--branch <b>] [--expected-sha <s>]
cofferdam file delete <path> [--message <m>] [--branch <b>]
cofferdam commit list [--ref <r>] [--path <p>] [--limit <n>] [--json]
cofferdam commit view <sha> [--patch] [--json]
cofferdam diff <base>...<head> [--json]
cofferdam search <query> [--ref <r>] [--json]

cofferdam issue list [--state <s>] [--label <l>] [--author <a>] [--limit <n>] [--json]
cofferdam issue view <n> [--comments] [--json]
cofferdam issue create --title <t> [--body <b> | --body-file <f>] [--label <l>]...
cofferdam issue edit <n> [--title <t>] [--body-file <f>] [--add-label <l>]...
cofferdam issue comment <n> [--body <b> | --body-file <f>]
cofferdam issue close <n>
cofferdam issue reopen <n>

cofferdam pr list [--state <s>] [--limit <n>] [--json]
cofferdam pr view <n> [--comments] [--json]
cofferdam pr create --base <b> --head <h> --title <t> [--body-file <f>]
cofferdam pr diff <n>
cofferdam pr comment <n> [--body <b> | --body-file <f>]
cofferdam pr merge <n> [--squash] [--delete-branch] [--message <m>]
cofferdam pr checks <n> [--json]                    runs whose sha is this pull request's head
cofferdam pr close <n>
cofferdam pr reopen <n>

cofferdam release list [--json]
cofferdam release view <tag> [--json]
cofferdam release create <tag> [--title <t>] [--notes-file <f>] [--prerelease]
cofferdam release edit <tag> [--title <t>] [--notes-file <f>] [--prerelease | --latest]
cofferdam release delete <tag> --yes

cofferdam workflow list [--ref <r>] [--json]
cofferdam workflow run <workflow> [--ref <r>] [--field k=v]...
cofferdam run list [--limit <n>] [--status <s>] [--json]
cofferdam run view <n> [--job <j>] [--log] [--tail <n>] [--json]
cofferdam run watch <n> [--interval <s>] [--timeout <s>] [--exit-status] [--json]
cofferdam run cancel <n>
cofferdam run rerun <n>
cofferdam run download <n> [--artifact <name>] [--dir <d>]

cofferdam api <path> [--method <m>] [--field k=v]... [--raw-field k=v]... [--input <f>]
cofferdam config view|set                           vault theme and CI retention
cofferdam user view|delete|token list|token revoke   alongside the existing add|grant|list
cofferdam collection delete <name>
```

Three of these deserve comment.

**`cofferdam api`** is the escape hatch and should be built first, in phase 1. It takes a path
under `/api` (or a full one, tolerating a leading slash or not), sends the bearer token, prints
the response body verbatim, and exits non-zero on a non-2xx status with the body on stderr.
`--field k=v` builds a JSON object, coercing `true`, `false`, `null`, and integers, with
`--raw-field` forcing strings, matching `gh api`. `--input <file>` sends a body from a file or
`-` for stdin. With this in place, every capability of the API is reachable the day the API
route lands, and a typed command that has not been written yet is an inconvenience rather
than a blocker.

**`cofferdam run watch`** polls `GET /api/repos/:c/:r/runs/:n` until the run completes, with
`--interval` defaulting to 5 seconds and `--timeout` to 30 minutes, then prints the final
status. `--exit-status` makes a failed run a non-zero exit, which is what a script wants. This
is the difference between an agent that can dispatch a workflow and one that can act on the
result. Poll rather than stream: the engine has no event channel, the vault reads state off
disk per request, and a 5-second poll on a local process costs nothing.

**`cofferdam repo clone`** exists because the URL is otherwise assembled by hand from the
login. It is a thin wrapper over `git clone` with the vault host and the credential
arrangement already in place.

### Parsing

`src/index.ts` parses arguments with a hand-rolled loop per command family and a single
`usage()` holding every command's help text. That works at ten commands and will not at
seventy: the help text alone would be several hundred lines, and each new command family
repeats the same option loop (compare `parseUserArgs` in `src/index.ts:214`, `parseArgs` in
`src/runner-cli.ts:24`, and `parseImportArgs` in `src/import-cli.ts:26`).

Replace it with one small internal parser, in `src/cli/parse.ts`, before adding commands. It
should not be a dependency; the requirement is modest:

- A command registry: `{ path: ['issue', 'create'], summary, options, args, run }`.
- Option specs with a type (`string`, `boolean`, `string[]`, `int`) so parsing and validation
  are declared once, and `--json` and the vault-target options are shared.
- Help generated from the registry, so `cofferdam --help` lists command groups only,
  `cofferdam issue --help` lists that group, and `cofferdam issue create --help` lists that
  command's options. This keeps `--help` output small enough for an agent to read, which the
  current single 120-line dump is not.
- `cofferdam commands --json`, dumping the registry: every command, its options, and its
  summary. An agent handed this needs no documentation to discover the surface, and it is
  free once the registry exists.
- Unknown flags and unknown commands exit 2 with a suggestion when the edit distance to a
  real name is 1 or 2.

Existing commands move into the registry unchanged in behaviour. `serve`, `deploy`, and
`runner run` keep their current argument handling internally if that is less disruptive; what
matters is that they are reachable through the same dispatch and appear in the same help.

## Extraction work

Some operations exist only as a sequence inside a web handler. Each must move to a function
that takes plain values and returns a result or throws `OpError`, called by both the web
handler and the API handler. Behaviour must not change; the web smoke tests are the proof.

| Now | Extract to | Callers |
| --- | --- | --- |
| Merge sequence: `previewMerge`, `mergeBranch`, `recordMerge`, optional `deleteBranch` (`src/pullweb.ts:590-650`) | `ops.performMerge` or `pulls.mergePull` | `src/pullweb.ts`, `src/api/pulls.ts` |
| Dispatch: validate ref, find branch, collect `input.*`, `handleDispatch` (`src/ci/web.ts:295-339`) | `ci/dispatch.ts:dispatchWorkflow` | `src/ci/web.ts`, `src/api/ci.ts` |
| Editor commit: branch choice, `commitMessage`, `expectedSha` check, `commitFileChange`, `firePush` (`src/webops.ts:449-528`) | `ops.writeFile` taking an explicit `WriteRequest` | `src/webops.ts`, `src/api/contents.ts` |
| Repo creation with an initial README (`src/webops.ts:284-413`) | `ops.createRepoWithReadme` | `src/webops.ts`, `src/api/repos.ts` |
| Pull request creation, including the head/base validation (`src/pullweb.ts:424-459`) | `pulls.openPull` | `src/pullweb.ts`, `src/api/pulls.ts` |
| `firePush` (`src/webops.ts:95-110`) | `ci/trigger.ts:firePush(root, engine, ...)` | both web and API write paths |

The one behavioural difference between the two transports is who the actor is: a `Viewer` from
the session cookie on the web, an `AuthResult` from the bearer token on the API. Both already
carry `auth.username` and the same scope arrays, so the extracted functions should take a
`{ username: string }` actor and nothing else, and each transport builds its own.

## Testing

`scripts/smoke.sh` is the project's test suite and it already drives the web routes with curl
and a cookie jar (`scripts/smoke.sh:121-227`). Extend it, do not replace it:

- A parallel `api()` helper alongside `check()`, sending `Authorization: Bearer
  $DEV_TOKEN`, asserting the status and optionally piping the body through a `jq`-free check
  (the repo has no jq dependency; grep on the JSON is what the existing tests do).
- For every write operation, one test that it works with a scoped token and one that it is
  refused with a token that lacks scope. The scope matrix is where a mistake in a new
  transport is most likely and least visible.
- A test that a session cookie does *not* authorize an API route, and that a bearer token
  does not authorize an HTML POST. Both directions, because the whole auth story rests on it.
- A test that a commit made over the API triggers a workflow run, which is the divergence
  most likely to be missed.
- For each extracted function, the existing web test stays and an API test is added beside it,
  so the extraction is proven not to have changed the web behaviour.
- CLI-level tests for `cofferdam api`, one read and one write, and for `--json` output
  being parseable and going to stdout while diagnostics go to stderr.

The example vault (`npm run example`) already creates a `dev` user with the fixed token
`cofferdam_example_dev_token`, which is what these tests should use. Add a second example user
with narrow scope, since half the tests above need one.

## Documentation

- **`docs/api.md`,** new: every route, its body, its response, and its authorization. This is
  the reference `docs/cli.md` currently gestures at with a nine-line table.
- **`docs/agents.md`,** new and deliberately short, under 200 lines: how to authenticate in a
  container, the command groups, the JSON shapes, the exit codes, `cofferdam api`, and an
  honest list of what cofferdam does not have that `gh` does (reactions, reviews, assignees,
  milestones, projects, checks, webhooks, release assets). The list is the most useful part:
  it stops an agent from trying, failing, and inferring that it is holding the tool wrong.
- **`docs/cli.md`,** updated: the new commands, the environment variables, and the paragraph
  about there being nothing to set in the environment.
- **`README.md`,** updated: the "A CLI and a JSON API for users, collections, and importing
  existing repositories" line understates the result, and the roadmap line about JSON on read
  routes and UI operations mirrored into the API is what this change closes.
- `scripts/check-links.sh` covers documentation links; new files must pass it.

## Phasing

Each phase leaves the tree working, tested, and documented, and each is independently
valuable. Do not start a later phase to finish an earlier one.

**Phase 0, foundations.** `src/cli/parse.ts` with the registry, existing commands moved onto
it, `--json` plumbing, exit codes in `src/cli-api.ts`, `COFFERDAM_HOST` / `COFFERDAM_TOKEN` /
`--token-stdin`, `cofferdam api`, and `src/api/auth.ts` split out of `src/api.ts`. No new
capability, and after it an agent can already reach the seven existing routes without a typed
command for each.

**Phase 1, read the repository, write issues and pull requests.** `src/api/repos.ts` (reads
only), `src/api/contents.ts` (reads only), `src/api/issues.ts`, `src/api/pulls.ts` including
merge preview and merge, and the CLI groups `repo view|list`, `file`, `commit`, `diff`,
`search`, `issue`, `pr`. Extraction of the merge and pull-creation sequences. This is the
phase that makes an agent useful, and if only one phase lands it should be this one.

**Phase 2, write the repository.** Contents writes, multi-file commits, branches, tags,
repository create, fork, edit, rename, delete, and `firePush` on API writes. Extraction of the
editor commit path and repository creation.

**Phase 3, workflows.** `src/api/ci.ts`, the `workflow` and `run` command groups including
`run watch` and `run download`, and extraction of the dispatch sequence.

**Phase 4, releases, sites, administration.** `src/api/releases.ts`, the site read route,
token ids and revocation, config read and write, collection delete, and the remaining user
commands.

**Phase 5, documentation.** `docs/api.md`, `docs/agents.md`, and the updates to `docs/cli.md`
and `README.md`. Earlier phases update `docs/cli.md` as they go; this phase is the reference
material and the honest gap list.

## Risks

- **Authorization drift.** Two transports over one domain layer is two places to forget a
  `canPush`. The mitigation is that no API handler calls a domain function directly: it goes
  through `requirePush`, which loads the repository and the scope together and returns a typed
  actor, so a handler that skips the check has nothing to call the domain function with. Write
  it that way, not as a helper a handler may forget to call.
- **The API becoming the more capable interface.** Once an operation exists in both, the
  temptation is to add the next one to the API only, and the web interface quietly falls
  behind. Nothing in this spec prevents that; it is a review habit.
- **Surface size.** This roughly quintuples the CLI. The registry, per-group help, and
  `cofferdam commands --json` are what keep it navigable, which is why phase 0 comes first.
- **Ossification.** Documented routes are harder to change than HTML ones. Keep the response
  objects the domain interfaces (`IssueSummary`, `RunRecord`) rather than hand-built shapes,
  so a field added to the vault's state appears in the API without a decision.
