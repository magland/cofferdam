# Sites

A static site per repository, served from a sibling directory.

A repository can have a static site, served at `/<collection>/<repo>/site/`. The content is plain files in a sibling directory next to the bare repository:

```
<root>/alice/
  webapp.git/     (the repository)
  webapp.site/    (its site; index.html at the root)
```

Anything that can write files can publish: a manual copy, a build script, a workflow. Directory requests serve `index.html`, and a `404.html` at the site root, if present, is used for missing paths. When the directory exists, a Site tab appears in the repository's navigation.

Everything in the directory is served, dotfiles included, so copy in what you mean to publish and not, say, a working tree with its `.git` alongside it. What is not served is anything outside the directory: a symlink that resolves out of the site, including into another repository's site, reads as a missing file.

## Site content is untrusted code

A site is HTML and script written by whoever can write the directory, which is anyone with push scope on the repository and any workflow that publishes it. Publishing a site is therefore a real privilege, and it should be read that way when handing out scope.

It matters because of what a document can do on the origin it is served from. Site files live under the vault's own hostname, so without a boundary a site's script could `fetch('/anything', {credentials: 'include'})` with the visitor's session cookie, read the response, take the CSRF token out of any page that session can load, and then post as that visitor. If the visitor happened to be an owner, that reaches user creation and token minting. `httpOnly` and `sameSite` do not help, because the script is not cross-origin.

So site responses are sandboxed. Each one carries:

```
Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads
Access-Control-Allow-Origin: *
X-Content-Type-Options: nosniff
```

The absence of `allow-same-origin` is the point: it places the document in an opaque origin, which is not the vault's origin and not any other site's either. Script still runs, so most of what a static site does still works. What a sandboxed site cannot do:

- read or write cookies, including its own; `document.cookie` is empty and setting it does nothing
- use `localStorage` or `sessionStorage`; touching either **throws**, so a library that reaches for it without a guard will fail rather than degrade
- use `IndexedDB`
- register a service worker, so an offline-first app will not install

`Access-Control-Allow-Origin: *` is there so that a page in an opaque origin can still `fetch` its own sibling files, which is what a single-page app, a wasm loader, or any data-driven site needs. Those requests carry no credentials, so allowing them gives nothing away. The header goes on site responses only, never on forge pages and never on the API.

GitHub calls this feature Pages, and earlier versions of cofferdam did too, with the directory named `<repo>.pages`. We renamed it because "pages" already means something else in a web interface made of pages. A vault created before the rename needs one command per site: `mv <repo>.pages <repo>.site`.
