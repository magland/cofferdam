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

## A hostname per site

A sandbox is the right default because it needs no configuration and works on a bare `*.fly.dev` name. It is also blunt: a site that wants storage, or a service worker, or a cookie of its own has no way to get one. The alternative is to give each site a real origin, which is what a hostname does.

Set one in the vault's `config.json`:

```json
{
  "sites": { "host": "vault1-sites.magland.org" }
}
```

Each eligible repository's site is then served from `<repo>--<collection>.<sites host>`, so `webapp` in collection `alice` becomes `webapp--alice.vault1-sites.magland.org`. On that hostname the repository is the origin root: `/index.html` is the site's own, and so are `/assets/style.css` and `/favicon.svg`, which the forge does not shadow there. No session is ever resolved on a sites hostname and no cookie is set on one, so a site cannot see a visitor's session even in principle. Responses carry `X-Content-Type-Options: nosniff` and nothing else; the sandbox is gone, because the origin is now doing that work.

The forge path keeps working and redirects: `/<collection>/<repo>/site/...` answers `302` to the same path on the site's origin, query string included. It is a temporary redirect on purpose, so removing `sites.host` takes effect on the next request rather than after every cache in the way has forgotten it. The Site tab links straight to the origin.

The double hyphen is the separator, and it is unambiguous because neither half may contain one. A collection or repository name may appear in a hostname only if it matches `^[a-z0-9]+(-[a-z0-9]+)*$`: lowercase letters, digits, and single interior hyphens. That rules out uppercase, dots, underscores, leading and trailing hyphens, and doubled hyphens. The combined label must also fit in the 63 characters DNS allows.

Repository names are more permissive than that, so **not every repository is eligible**, and an ineligible one keeps being served on the forge host under the sandbox. This refuses rather than lowercases, because lowercasing `Webapp1` would collide with a `webapp1` beside it: hostnames are case-insensitive and both names are legal on disk. It is a documented rule, not a bug, and the Site tab points wherever that repository's site actually is.

A value that is not a plausible hostname is ignored and the default used, the same way an unknown theme name is, so a typo in `config.json` cannot take the vault down or serve sites from a name no certificate covers.

### What a hostname does and does not isolate

Per-repository hostnames give each site its own storage, its own DOM, and its own service worker scope. They do **not** isolate cookies. The cookie boundary is the registrable domain, not the hostname, so a site at `a--alice.vault1-sites.magland.org` can set a cookie with `Domain=vault1-sites.magland.org`, which every other site on that host then receives. Fixing that would need the sites domain on the Public Suffix List, which is a submission rather than a code change.

So a site wanting private state should use `localStorage` or IndexedDB, which are keyed by origin and therefore genuinely separate. Treat cookies on a shared sites host as readable by every site on it.

The vault's own session cookie is not affected: it is set only on the forge's hostname, and over https it carries the `__Host-` prefix, which browsers refuse to accept from a cookie bearing a `Domain` attribute. That closes the other direction, where a sibling subdomain shadows a real session with one of its own.

The DNS records and certificates this needs are in [A domain of your own](deploying.md#a-domain-of-your-own).

GitHub calls this feature Pages, and earlier versions of cofferdam did too, with the directory named `<repo>.pages`. We renamed it because "pages" already means something else in a web interface made of pages. A vault created before the rename needs one command per site: `mv <repo>.pages <repo>.site`.
