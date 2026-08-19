# Spec: backing up a vault to your own machine

This is an implementation handoff document, not user documentation. It describes a change to be made to cofferdam; delete it once the change has landed and `docs/backup.md` (new) describes the result.

## The problem

A vault is a directory, so the documentation is entitled to say that backing one up is `cp -a` and moving one is `rsync` (`docs/vault.md`, `docs/deploying.md`). That is true of a vault on a machine you have a shell on. It is not true of the deployment the CLI actually encourages: `cofferdam deploy fly` puts the vault on a Fly volume, where there is no shell in the ordinary sense, no rsync at the far end, and no filesystem access except through `fly ssh`. The only supported ways to get a copy of such a vault today are `fly ssh console` with a hand-written `tar` pipeline, which transfers everything every time and is specific to one host, and Fly's own volume snapshots, which live at the same provider as the thing they protect and are therefore not a backup in the sense that matters.

What is wanted is unglamorous: a copy of the vault on a disk of one's own, updated incrementally so that a daily run moves kilobytes rather than gigabytes, with periodic snapshots so that a deletion noticed a week later can still be undone.

Note that half of the problem is already solved and needs no new code. A bare repository is the bulk of a vault's bytes, and `git fetch` into a mirror is the best incremental transfer available for it: it moves only the objects the far end lacks, it is atomic per ref, and it runs over the anonymous smart-HTTP endpoint the server already serves on every clone (`src/githttp.ts`). What has no transport is everything beside the repositories: issues, pull requests, releases, sites, run history, LFS objects on the volume, and the four state files at the vault root.

## What this change delivers

- **`cofferdam backup <dir>`,** an incremental pull of a whole vault over HTTP, which works identically against a Fly app, a VPS, a Docker deployment, and `127.0.0.1:3000`, and which needs no shell on the server and no flyctl.
- **A backup directory that is itself a vault,** so that restoring is `cofferdam serve <dir>/current` rather than a program that only gets exercised during a disaster.
- **Snapshots and retention,** as hardlinked copies pruned on a grandfather-father-son schedule, so a snapshot costs inodes rather than bytes and is itself a servable vault.
- **Two new API routes** under `/api/backup`, which are the only server-side additions: a manifest and a bulk file fetch.
- **`docs/backup.md`,** and the corrections to `docs/vault.md` and `docs/deploying.md` that stop claiming `cp -a` covers the deployment the CLI recommends.

### Not in scope

- **LFS objects in a bucket.** With `--lfs-bucket` the objects are not in the vault at all (`src/lfsstore.ts`, `docs/lfs.md`), and re-implementing bucket-to-disk sync would be a worse `rclone`. The backup records that the vault uses a bucket, warns once, and `docs/backup.md` says to run `rclone sync` alongside.
- **Restoring by pushing a backup into a live vault.** Restore is "serve this directory", or copy it onto the new host's volume and serve it there. A `cofferdam restore` that reconciles a backup against a running vault is a different and much harder operation, and inventing it would leave two restore paths of which only one is ever tested.
- **Encryption and off-site replication.** The backup directory is plain files, so `restic`, `borg`, `rclone`, or a Time Machine volume can be pointed at it. Duplicating any of that here would be machinery with nothing to carry.
- **Per-collection backups.** The first version backs up a whole vault, authorized by a token with admin scope over all of it, because the result is a complete vault including `vault.json`. A partial backup cannot be served as-is, and its authorization cases are worth adding only if someone asks.
- **A point-in-time image of the vault.** See [Consistency](#consistency-and-what-a-backup-does-not-promise); this is a documented limitation, not an omission to be engineered around later.

## The shape: a backup is a vault

```
~/backups/vault1/
  backup.json           which vault, what is excluded, how each run went
  current/              a servable vault: vault.json, config.json, alice/webapp.git/, ...
  snapshots/
    2026-08-19T140311Z/ hardlinked copy of current at that moment
    2026-08-18T140256Z/
  .lock
```

`current/` mirrors the layout in `docs/vault.md` exactly, with each `<repo>.git` a mirror created by `git clone --mirror`, which is a bare repository like any other. So the recovery procedure is one line, it can be rehearsed at any time, and it is the same line whether the vault is being inspected locally or stood back up on a new host.

`backup.json` holds what a later run must not have to be told again: the vault URL, the exclusions in force, the retention policy, and a short history of runs (started, finished, bytes moved, counts). It is written with `writeFileAtomic` (`src/atomic.ts:26`), like every other state file in this project.

## The transport

### Repositories

For each repository in the manifest, a mirror in `current/<collection>/<repo>.git`:

```
git clone --mirror <vault>/<collection>/<repo>          # first time
git fetch --prune 'refs/*:refs/*'                       # every time after
```

with `core.logAllRefUpdates=false` set on the mirror, so that no file in the backup is ever appended to in place (see [Snapshots](#snapshots)). Reads are anonymous, so no credential is needed for this half, and `git-upload-pack --advertise-refs` advertises every ref (`src/githttp.ts:184`), so `refs/*:refs/*` really is the whole repository.

A repository whose refs digest in the manifest matches the digest recorded by the previous run is skipped entirely, which is what keeps a nightly run over a hundred quiet repositories to a single request rather than a hundred handshakes against a machine that has to wake up first.

### Everything else

Two routes, in a new `src/api/backup.ts` registered from `src/api.ts` beside the WIP modules (`registerRepoApi`, `registerContentsApi`, and the rest).

**`GET /api/backup/manifest`** streams NDJSON, so a large vault costs the 512mb Fly machine nothing:

```jsonl
{"kind":"vault","lfs":"volume","excluded":[]}
{"kind":"file","path":"vault.json","size":812,"mtime":1755600123456}
{"kind":"repo","path":"alice/webapp.git","refs":"3f9a...","packed":48213004}
{"kind":"file","path":"alice/webapp.issues/7/issue.json","size":344,"mtime":1755600123456}
{"kind":"end","files":9143,"bytes":1043221,"repos":12}
```

`?hash=1` adds `sha256` to each file line, for `--checksum` runs and for `verify`. Paths are vault-relative and always POSIX-separated. Repository directories are reported as `kind:"repo"` and their contents are *not* enumerated as files: git is their transport. The refs digest is a hash over `for-each-ref --format='%(refname) %(objectname)'`, which is cheap and changes on any push.

**`POST /api/backup/fetch`** takes `{"paths":[...]}` and streams the bytes of each, as a length-prefixed sequence rather than a tar:

```
<line: {"path":"alice/webapp.issues/7/issue.json","size":344}\n><344 bytes>
<line: {"path":...,"size":...}\n><bytes>
<line: {"end":true,"missing":["alice/webapp.issues/9/body.md"]}\n>
```

The server spawns `tar` elsewhere (`src/ci/artifacts.ts:109`), but a length-prefixed stream needs no tar on either side, has no symlink, ownership, or path-traversal edge cases, and lets a file that vanished mid-run be reported rather than aborting the stream. Bounded per request at 2000 paths or 64 MB of body, whichever comes first, over which the response is a `400` naming the limit; the client chunks to fit.

Both routes require a token whose admin scope covers the whole vault, checked with `canAdmin` (`src/vault.ts:185`) against `['*']`, because the manifest necessarily covers `vault.json` and `.secret`. Both are wrapped in the existing `tree` gate (`src/limit.ts:222`), so that a backup in progress cannot crowd out a push, and both refuse any path that escapes the vault root, reusing the checks in `src/scan.ts` rather than writing new ones.

### Change detection

Size and modification time, as rsync does by default: a file whose size and mtime match what the last run recorded is not fetched. `--checksum` asks for hashes instead and compares those, which is the slower, more paranoid mode. The manifest is authoritative for deletions: a path in `current/` that the manifest does not list is removed, and so is a mirror whose repository is gone from the vault. Deleted data therefore survives in the snapshots and nowhere else, which is the behaviour that makes retention worth configuring.

Every write into `current/` goes to a temporary file in the same directory and is renamed into place. This is required by the snapshots and is the convention the server already follows.

## The client

```bash
cofferdam backup ~/backups/vault1              # incremental sync of current/
cofferdam backup ~/backups/vault1 --snapshot   # ...then snapshot, then prune
cofferdam backup list ~/backups/vault1
cofferdam backup verify ~/backups/vault1
cofferdam backup prune ~/backups/vault1
```

A new group in the command registry (`src/cli/parse.ts:53`), implemented in `src/cli/backup-cmd.ts`. Host and token resolve exactly as every other command's do, through `targetFrom` (`src/cli/target.ts`): the option, then the environment, then what `cofferdam login` left behind. So a cron entry is the command and a directory.

Options, all recorded in `backup.json` so that later runs need not repeat them:

| Option | Effect |
| --- | --- |
| `--snapshot` | Take a snapshot after a successful sync, then prune |
| `--keep-daily N`, `--keep-weekly N`, `--keep-monthly N` | Retention (defaults 7, 4, 6) |
| `--no-runs`, `--no-sites`, `--no-lfs` | Exclude `<repo>.runs`, `.site`, `.lfs` |
| `--no-secrets` | Exclude `vault.json`, `runners.json`, and `.secret` |
| `--checksum` | Compare hashes rather than size and mtime |
| `--json`, `--quiet` | A machine-readable summary; or nothing on success |

Run history is included by default. It is the largest churning part of a vault and CI retention already trims it (`docs/workflows.md`), but a backup that silently drops a category of thing the web interface shows is a backup that surprises someone eventually; `--no-runs` is there for anyone who would rather have the bytes.

`.lock` in the backup directory makes a second concurrent run exit 5 (the conflict code, `src/cli/exit.ts`) rather than interleave, and a lock whose holder is gone is broken with a warning. Exit codes are the ones in `docs/cli.md`; `--json` failures are `{"error":"..."}` on stderr, as elsewhere.

`verify` runs `git fsck --connectivity-only` over each mirror, re-requests the manifest with `?hash=1`, and reports anything missing, extra, or wrong. `list` prints the snapshots with their timestamps and apparent sizes. `prune` applies retention without syncing.

## Snapshots

After a successful sync, `snapshots/<utc-timestamp>/` is built by walking `current/` and hardlinking every file. A snapshot of a 5 GB vault costs one inode per file and no data, and it is a directory that can be served, diffed, or copied out with ordinary tools.

This is safe only because nothing in the backup is modified in place: git rewrites refs, `packed-refs`, and packfiles by rename, cofferdam writes its state files by rename, the client writes by rename, and reflogs, the one thing git appends to, are turned off on the mirrors. Any future code that opens a file in `current/` for appending breaks every existing snapshot, so `docs/backup.md` should say so and the walk should refuse a file with a link count it did not create.

Retention is grandfather-father-son: keep the last N daily, weekly, and monthly snapshots, evaluated in UTC. The honest cost, which belongs in the documentation rather than in a workaround: a snapshot pins the packfiles that were current when it was taken, so a repack in a busy repository leaves the old pack on disk until the last snapshot referencing it is pruned. Disk use grows faster than the vault does, and pruning is what reclaims it.

## Consistency, and what a backup does not promise

There is no vault-wide point-in-time image. The server reads and writes what is on disk per request and holds no lock a client could take, so a backup is a walk of a live tree.

The failure mode this produces is a mixed vintage, not a corrupt file. Each ref update is atomic and each state file is written by rename, so every individual file in a backup is a file that really existed; what can differ is which moment each of them came from. A pull request merged halfway through a run might be captured with its merge commit but its pre-merge state, and the next run corrects it. One cheap mitigation is worth including: after the data pass, re-request the manifest and re-fetch anything whose mtime moved during the run, which closes the window for everything but a file written twice in the same run.

## Fly specifics

The machine stops when idle and starts on the next request (`min_machines_running = 0`, `docs/deploying.md`), so the first request of a backup wakes it and waits a few seconds; the client should say so rather than appear hung. A backup keeps the machine awake for its duration, which costs a little. Fly's daily volume snapshots remain a useful complement and are not a substitute, since they live at the same provider as the volume. `cofferdam deploy fly show` should grow one line naming the vault's backup, if `backup.json` on this machine points at that app.

## Phasing

1. **`src/api/backup.ts`:** the manifest and fetch routes, gated, admin-scoped, path-checked.
2. **`src/cli/backup-cmd.ts`:** mirror clone and fetch, file sync with deletions, `backup.json`, the lock, `--json`.
3. **Snapshots:** the hardlink walk, retention, `list`, `prune`.
4. **`verify`,** and the `deploy fly show` line.
5. **`docs/backup.md`,** a README mention, and the corrections to `docs/vault.md` and `docs/deploying.md`.

Parts 1 and 2 are the useful minimum: an incremental copy on your own disk, servable.

## Testing

In `scripts/smoke.sh`, against the example vault the suite already serves:

- Back up an empty-ish vault; assert `current/` serves and browses under a second `cofferdam serve`.
- Mutate the vault (a push, an issue, a comment, a release), back up again, and assert that the second run reports far fewer bytes than the first and that the new state is present.
- Delete a repository and an issue, back up, and assert both are gone from `current/` and present in a snapshot taken before.
- Take two snapshots and assert the second costs almost no disk (compare `du` against apparent size, or link counts).
- Assert the routes refuse a token without whole-vault admin scope, and that a `..` in a fetch path is refused.
- Run `backup verify` and assert it is clean, then corrupt a file in `current/` and assert it is not.
