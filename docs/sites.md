# Sites

A static site per repository, served from a sibling directory.

A repository can have a static site, served at `/<collection>/<repo>/site/`. The content is plain files in a sibling directory next to the bare repository:

```
<root>/alice/
  webapp.git/     (the repository)
  webapp.site/    (its site; index.html at the root)
```

Anything that can write files can publish: a manual copy, a build script, a workflow. Directory requests serve `index.html`, and a `404.html` at the site root, if present, is used for missing paths. When the directory exists, a Site tab appears in the repository's navigation.

GitHub calls this feature Pages, and earlier versions of cofferdam did too, with the directory named `<repo>.pages`. We renamed it because "pages" already means something else in a web interface made of pages. A vault created before the rename needs one command per site: `mv <repo>.pages <repo>.site`.
