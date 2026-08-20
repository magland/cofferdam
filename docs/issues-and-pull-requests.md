# Issues and pull requests

What an issue and a pull request are on disk, and what the interface does with them.

Every repository has an issue tracker at `/<collection>/<repo>/issues`. Reading issues is anonymous, like everything else here; opening one and commenting need a signed-in user, and closing, reopening, or editing needs push access or being the person who wrote it. Bodies are markdown, rendered by the same pipeline as a README.

They are files, not rows:

```
collections/alice/repos/
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

Pull requests live beside them in `<repo>.pulls/`, in deliberately the same shape, down to the frontmatter and the numbering. A pull request is a discussion with a branch pair attached: what it adds to an issue is the base and head refs, and what became of it (merged, with the merge commit and who made it, or closed, with who closed it).

```
collections/alice/repos/
  webapp.pulls/
    1/
      pull.md           (frontmatter: title, state, author, created, updated, base, head)
      comments/
        1.md
```

Note that no diff and no commit list is ever stored. Those are questions for git, answered from base and head at the moment the page is drawn, so a pull request cannot go stale against the branches it describes. Open one from the Compare button on any branch, or at `/<collection>/<repo>/pulls/new`. Merging happens in the bare repository, as a merge commit or a squash, and is refused rather than attempted when the two sides conflict; afterwards the head branch can be deleted from the same page. Merging needs push access over the repository.
