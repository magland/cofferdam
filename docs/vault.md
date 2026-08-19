# The vault

How a vault is laid out on disk, and how signing in to the web interface relates to the tokens git uses.

A vault is a plain directory. Each subdirectory of it is a collection, and each subdirectory of a collection is a bare git repository; everything else a repository accumulates sits beside it under a suffixed name:

```
<vault>/
  vault.json              (users and hashed tokens; created on first start)
  config.json             (vault settings: theme, sites host, CI retention, limits)
  .secret                 (session-cookie signing key; created on first need)
  runners.json            (registered workflow runners; created when you add one)
  alice/
    hello-numerics.git/   (bare repository)
    hello-numerics.runs/  (its workflow runs and logs)
    webapp.git/
    webapp.site/          (static site for webapp)
    webapp.issues/        (its issues, one directory each)
    webapp.pulls/         (its pull requests, one directory each)
    webapp.releases/      (its release notes, one file per tag)
    webapp.lfs/           (its Git LFS objects, when no bucket is configured)
  bob/
    notes.git/
```

The `.git` suffix on repository directory names is optional; it is stripped for display either way.

There is nothing else: no database, and no state outside this directory. That is what makes backing up a vault `cp -a` and moving one to another machine `rsync`, and it means each part of a vault can be read, written, and grepped with ordinary tools while the server is running, since the server reads what is on disk on every request. Both of those need a shell where the vault is, which a vault on a Fly volume does not have; [Backing up a vault](backup.md) is the same copy pulled over HTTP instead, and is what to use for a hosted vault. Each of these directories is described alongside the feature that writes it: [issues and pull requests](issues-and-pull-requests.md), [sites](sites.md), [workflows](workflows.md), and [Git LFS](lfs.md).

## Signing in on the web

Users sign in with their username and an existing token, the same credential git uses for pushing; there are no passwords and no separate web credential. The server sets a signed, stateless session cookie (30 days, `HttpOnly`, `SameSite=Lax`, `Secure` over HTTPS). The signing key lives in `<vault>/.secret`; rotating that file invalidates every session at once, and permissions are re-derived from `vault.json` on every request, so a scope taken away from a user applies to their open session on their next click. A session is bound to the token it was created with, and that token is looked up in `vault.json` on every request, so deleting one token ends the sessions started with it and leaves the user's other sessions untouched. Deleting the user ends all of theirs, and rotating `.secret` remains the way to end every session on the server at once.

Abilities in the interface mirror the token model exactly. Push scope over a repository enables creating it, editing files, and managing branches and tags; admin scope enables user management and repository deletion. Signing in with a restricted (token-scoped) token carries that restriction into the session, and such sessions have no admin rights. Controls a user cannot use are simply not shown.

File edits use optimistic concurrency: the edit form records the commit it was loaded against, and if the branch moves before you commit, the edit is refused with a conflict page rather than clobbering the other change. Web commits are authored as `<username> <username@noreply.<host>>`.

One deliberate asymmetry: repositories created by push set `receive.denyDeletes`, so `git push --delete` is refused, while the web interface allows branch deletion after confirmation. The receive hook guards against accidents; a confirmed click is explicit intent.
