# The vault

How a vault is laid out on disk, and how signing in to the web interface relates to the tokens git uses.

A vault is a plain directory. Its collections are in `collections/`, and a collection's repositories are in that collection's `repos/`; everything else a repository accumulates sits beside it there, under a suffixed name:

```
<vault>/
  vault.json                    (users and hashed tokens; created on first start)
  config.json                   (vault settings: theme, sites host, CI retention, limits)
  .secret                       (session-cookie signing key; created on first need)
  runners.json                  (registered workflow runners; created when you add one)
  collections/
    alice/
      repos/
        hello-numerics.git/     (bare repository)
        hello-numerics.runs/    (its workflow runs and logs)
        webapp.git/
        webapp.site/            (static site for webapp)
        webapp.issues/          (its issues, one directory each)
        webapp.pulls/           (its pull requests, one directory each)
        webapp.releases/        (its release notes, one file per tag)
        webapp.lfs/             (its Git LFS objects, when no bucket is configured)
    bob/
      repos/
        notes.git/
```

The `.git` suffix on repository directory names is optional; it is stripped for display either way.

Two levels of the tree hold only things somebody named, and nothing else. That is what `collections/` and `repos/` are for: the vault's own files sit beside its collections rather than among them, and a collection can gain files of its own without any of them being a name a collection or a repository may then never be called. A file added to the vault later takes no name away from a vault that already exists.

There is nothing else: no database, and no state outside this directory. That is what makes backing up a vault `cp -a` and moving one to another machine `rsync`, and it means each part of a vault can be read, written, and grepped with ordinary tools while the server is running, since the server reads what is on disk on every request. Both of those need a shell where the vault is, which a vault on a Fly volume does not have; [Backing up a vault](backup.md) is the same copy pulled over HTTP instead, and is what to use for a hosted vault. Each of these directories is described alongside the feature that writes it: [issues and pull requests](issues-and-pull-requests.md), [sites](sites.md), [workflows](workflows.md), and [Git LFS](lfs.md).

## A vault from before this layout

Collections used to sit directly in the vault directory, and repositories directly in a collection. A vault written that way is moved to the current layout the first time a server that knows it starts, and nothing has to be asked for:

```
Migrated 2 collection(s) to collections/<collection>/repos/: alice, bob
```

The move is renames only. No file is read, copied, or rewritten, so it costs the same on a vault of one repository and a vault of a hundred gigabytes, and a full disk does not stop it. Repository and collection names do not change, so every URL, clone address, and token scope means afterwards exactly what it meant before. A vault already on this layout is read once and left alone, so the check costs nothing on every start after the first.

If the migration cannot be finished - a permission the server does not have, a collection already occupying a name in `collections/` - it says so and the vault is not served. That is deliberate: a vault whose repositories are all still on disk should not come up looking empty. An interrupted run leaves a `.collections-migrating` directory behind, and the next start finishes from it.

One thing does not move: Git LFS objects in a bucket. Their keys are a bucket's, not the vault directory's, and rewriting them would mean copying every object; the local backend's `.lfs` directories move with their repositories like everything else.

## Signing in on the web

Users sign in with their username and an existing token, the same credential git uses for pushing; there are no passwords and no separate web credential. The server sets a signed, stateless session cookie (30 days, `HttpOnly`, `SameSite=Lax`, `Secure` over HTTPS). The signing key lives in `<vault>/.secret`; rotating that file invalidates every session at once, and permissions are re-derived from `vault.json` on every request, so a scope taken away from a user applies to their open session on their next click. A session is bound to the token it was created with, and that token is looked up in `vault.json` on every request, so deleting one token ends the sessions started with it and leaves the user's other sessions untouched. Deleting the user ends all of theirs, and rotating `.secret` remains the way to end every session on the server at once.

Abilities in the interface mirror the token model exactly. Push scope over a repository enables creating it, editing files, and managing branches and tags; admin scope enables user management and repository deletion. Signing in with a restricted (token-scoped) token carries that restriction into the session, and such sessions have no admin rights. Controls a user cannot use are simply not shown.

File edits use optimistic concurrency: the edit form records the commit it was loaded against, and if the branch moves before you commit, the edit is refused with a conflict page rather than clobbering the other change. Web commits are authored as `<username> <username@noreply.<host>>`.

One deliberate asymmetry: repositories created by push set `receive.denyDeletes`, so `git push --delete` is refused, while the web interface allows branch deletion after confirmation. The receive hook guards against accidents; a confirmed click is explicit intent.

## Renaming a repository or a collection

A repository is renamed, or moved to another collection, from its own Settings page; the two are one operation, since both are a directory rename. A collection is renamed from a Settings page of its own, at `/<collection>/settings`, reached from the button beside its name. Both take admin scope over what is moving and push scope over where it lands, which for a collection means every repository in it: renaming a collection moves all of them, so admin scope has to cover each one, and push scope has to cover each one at the new name. An empty collection has nothing to ask about, so an admin glob naming the collection is enough. Nothing is confirmed by typing the name, as deletion is: a rename that was a mistake is undone by renaming it back.

Everything a repository or a collection has accumulated moves with it, including sites, workflow runs, issues, pull requests, releases, and Git LFS objects. Two things do not. Clones and remotes pointing at the old address stop working until their remote is changed, which is inherent: the address is the name. And token scopes in `vault.json` still name the old collection, so a scope that covered `oldname/*` covers nothing after the rename and has to be granted again under the new name; the page says so before the rename is made. Rewriting scopes automatically was considered and not done, since a glob is a statement about what a user may reach rather than a pointer to a directory, and quietly widening one is worse than leaving it to be granted deliberately.
