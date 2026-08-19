# Spec: isolating static sites from the forge origin

This is an implementation handoff document, not user documentation. It describes a change to
be made to cofferdam; delete it once the change has landed and `docs/sites.md` and
`docs/deploying.md` describe the result.

## The problem

Site files are the only place in cofferdam where bytes supplied by someone other than the
server are returned as HTML on the vault's own origin. Raw blob views set
`Content-Security-Policy: sandbox` (`src/browse.ts:344`), LFS object downloads set it too
(`src/lfs.ts:349`), and workflow artifacts go out as `application/x-tar` attachments
(`src/ci/web.ts:193`). The site route, `src/browse.ts:511-591`, calls `res.sendFile(target)`
with no security headers at all.

A document served from `/<collection>/<repo>/site/` therefore runs script on the forge's
origin. The session cookie is `httpOnly` and `sameSite: lax`, but neither helps, because the
script is not cross-origin:

1. `fetch('/anything', {credentials: 'include'})` sends the visitor's session cookie and the
   script reads the response.
2. The CSRF token is per session, not per form, and is rendered into every page the session
   can read (`src/session.ts:127-137`, `src/session.ts:139-142`). The script scrapes it out of
   any such page.
3. It then POSTs with that token as the visitor.

So the capability actually granted by "can write `<repo>.site`", which is held by anyone with
push scope on the repository and by any workflow that publishes it, is: run code as whichever
signed-in viewer loads the site. If that viewer is an owner, this reaches user creation and
token minting. That is a privilege escalation from any scoped user to vault owner in one page
load.

A second, independent problem: multiple vaults are expected to live on sibling subdomains of
one parent domain (`vault1.magland.org`, `vault2.magland.org`). Cookies are not scoped by
origin, so any document on any host under `magland.org` can set a cookie named
`cofferdam_session` with `Domain=magland.org`, which the browser then also sends to each
vault. `parseCookies` (`src/session.ts:76-90`) builds a flat name-to-value map and takes
whichever value arrived, so a sibling host can shadow a real session with one of its own.
This is true today, before any of the work below.

## What this change delivers

Three parts, independently useful, in this order:

- **Part A, sandbox by default.** Site responses get headers that put them in an opaque
  origin. Works on any deployment including a bare `*.fly.dev` hostname, needs no DNS and no
  configuration. Closes the escalation for every existing vault. Costs sites their access to
  cookies, `localStorage`, `IndexedDB`, and service workers.
- **Part B, an optional sites host.** When a vault is configured with one, each repository's
  site is served from its own hostname, `<repo>--<collection>.<sitesHost>`, with full browser
  capability and no session resolution on that host at all.
- **Part C, cookie hardening.** The `__Host-` cookie name prefix, so a sibling subdomain
  cannot shadow a session.

Parts A and C touch no infrastructure and should land first, in one change if convenient.
Part B is larger and depends on DNS and certificates the operator sets up.

### Not in scope

- Public Suffix List submission for a sites domain. Without it, sites on one sites host can
  still set `Domain=<sitesHost>` cookies that siblings receive, so cookies are shared between
  a vault's sites even in Part B. Document this; do not try to solve it in code.
- Per-collection hostnames (`<repo>.<collection>.<sitesHost>`), which would need one
  wildcard certificate per collection.
- A second Fly app to obtain a second origin without a custom domain. Vaults with no domain
  of their own use Part A.
- Rate limiting, HSTS, and any other headers not named below.

## Part A: sandbox site responses by default

### Behaviour

Every response that returns a byte of site content, including the site's own `404.html`
response, carries:

```
Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads
Access-Control-Allow-Origin: *
X-Content-Type-Options: nosniff
```

There is deliberately no `allow-same-origin`. Without it the document is placed in an opaque
origin: no cookie jar, no `document.cookie`, no `localStorage` or `IndexedDB`, no service
worker registration, and every request it makes to the vault is cross-origin and
credential-less. Script still runs, so the feature survives.

`Access-Control-Allow-Origin: *` is load-bearing and must not be dropped as redundant.
Without it a page in an opaque origin cannot `fetch` its own sibling files, which breaks any
single-page app, wasm loader, or data-driven site. With it those fetches succeed and still
carry no credentials, so nothing is returned to an attacker. It goes on site responses only.
Do not add it to forge pages or to any API route.

### Interaction with Part B

These headers are what a site gets when it is served on the forge host. A site served on its
own hostname under Part B gets `X-Content-Type-Options: nosniff` only: sandboxing it there
would defeat the purpose of giving it an origin, and `Access-Control-Allow-Origin` is
unnecessary because its own fetches are same-origin. The shared helper therefore takes the
mode as a parameter rather than deciding for itself.

## Part B: an optional sites host

### Configuration

Extend `VaultConfig` in `src/config.ts`:

```ts
export interface SitesConfig {
  /**
   * Hostname whose subdomains serve repository sites, e.g.
   * "vault1-sites.magland.org". Empty means sites are served on the forge
   * host, sandboxed.
   */
  host: string;
}
```

Default `{ host: '' }`. Follow the existing validation discipline in `loadConfig`: a value
that is not a syntactically plausible hostname is ignored and the default used, the way an
unknown theme name is, because a typo in `config.json` must not take the vault down. Accept a
value matching `/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/` after
lowercasing and stripping a trailing dot; reject anything else, including a value with a
port, a scheme, or a single label.

The setting is per vault, which `config.json` already is, so nothing structural is needed for
several vaults on one domain.

### Hostname grammar

A new module, `src/siteshost.ts`, owns the grammar in both directions so the parser and the
link builder cannot drift.

```ts
/** Whether a collection or repository name may appear in a site hostname. */
export function isSiteLabelSafe(name: string): boolean;

/** The full hostname for a repository's site, or null if it is not eligible. */
export function siteHostFor(sitesHost: string, collection: string, repo: string): string | null;

/** The collection and repository a request's hostname names, or null. */
export function parseSiteHost(sitesHost: string, hostname: string): { collection: string; repo: string } | null;
```

`isSiteLabelSafe` is `/^[a-z0-9]+(-[a-z0-9]+)*$/`. That regex, and not a longer list of
rules, is the whole definition: it admits lowercase letters, digits, and single interior
hyphens, and by construction rejects uppercase, `.`, `_`, a leading or trailing hyphen, a
doubled hyphen anywhere, and an empty string.

Repository and collection names are more permissive than this (`isValidName`,
`src/scan.ts:23-26`, allows `.`, `_`, and uppercase), so not every repository is eligible.
That is intended. Refuse rather than mangle, as `deploy fly` refuses a shrinking volume:
lowercasing `Webapp1` would collide with a `webapp1` beside it, since hostnames are
case-insensitive and both names are legal on disk. An ineligible repository keeps being
served on the forge host under Part A, and this is a documented rule, not a bug.

`siteHostFor` uses `displayName(repo)` (`src/scan.ts:77`) so a directory named `foo.git`
yields `foo`, returns null unless both names are label-safe, and returns null if
`` `${repo}--${collection}` `` exceeds 63 characters, the DNS label limit. The double hyphen
is an unambiguous separator precisely because neither half may contain one, so `a--b` in
collection `c` cannot be confused with `a` in collection `b--c`. It also means no label can
begin `xn--`, which a browser would read as punycode.

`parseSiteHost` lowercases the hostname, strips a trailing dot, requires it to end with
`.` + `sitesHost`, requires exactly one remaining label (a deeper name such as
`a.b.<sitesHost>` is refused, and is not covered by a single wildcard certificate anyway),
splits that label on `--` into exactly two parts, and requires both to be label-safe. It
performs no filesystem access; the caller resolves the names with `findRepo` as usual.

### Routing

The site handler must run before every other route when the request arrives on a sites
hostname, including before the `/assets/*` and `/favicon.svg` routes in `src/server.ts:38-83`.
Otherwise the forge's stylesheet route would shadow a site's own `assets/style.css` and the
favicon route would shadow a site's icon.

In `createApp`, immediately after the theme middleware, register:

```ts
app.use((req, res, next) => {
  const sitesHost = loadConfig(root).sites.host;
  if (!sitesHost) return next();
  const named = parseSiteHost(sitesHost, req.hostname);
  if (!named) {
    // Not a site hostname. A request to the bare sites host, or to a deeper
    // name under it, gets a minimal 404 rather than falling through to the
    // forge, so the forge is reachable only on its own hostname.
    if (isUnderSitesHost(sitesHost, req.hostname)) return sendSitesHost404(res);
    return next();
  }
  serveSite(root, named.collection, named.repo, req, res, 'host');
});
```

`req.hostname` is correct here: `trust proxy` is set (`src/server.ts:30`), so it honours
`X-Forwarded-Host` behind Fly or Caddy, and it excludes the port. Host-based gating is safe in
this direction. A request that arrives with a forged `Host: <repo>--<collection>.<sitesHost>`
reaches only the less privileged surface, and forging the forge's own hostname gains an
attacker nothing they would not get by visiting it, because the session is resolved only
there and only from a cookie the browser sends to the real host.

Only `GET` and `HEAD` are answered on a sites hostname. Any other method gets 405.

The 404 for a non-site name under the sites host is a self-contained minimal HTML page: no
stylesheet link (the asset routes are not reachable there), no session-dependent chrome, and
Part A's sandbox headers. Do not use `views.errorPage`, which renders forge chrome and would
arrive unstyled.

### The forge host under Part B

`/:collection/:repo/site/*` keeps its route and gains a decision at the top:

- If a sites host is configured and `siteHostFor` returns a hostname for this repository,
  respond `302` to `https://<host>/<rest of path>`, preserving the query string. Use 302 and
  not 301: a permanent redirect would be cached hard, and removing `sites.host` from
  `config.json` must take effect on the next request.
- Otherwise serve the file as today, with Part A's headers. This covers both a vault with no
  sites host and an ineligible repository in a vault that has one.

The scheme of the redirect target is `https` when `req.protocol` is `https`, and otherwise
mirrors the request, so a local http vault redirects to http and stays usable.

### Shared serving code

Extract the body of the existing route into `src/site.ts`:

```ts
export type SiteMode = 'sandbox' | 'host';
export function serveSite(root: string, collection: string, repo: string, req: Request, res: Response, mode: SiteMode): void;
```

It contains, unchanged in behaviour, everything at `src/browse.ts:513-590`: the `findRepo` and
`siteDir` lookups and their 404 messages, `fs.realpathSync` of the site directory, rejection
of `..` and NUL in path segments, the `statInside` helper built on `containedIn`
(`src/ops.ts:517`) that refuses the site directory itself and anything not strictly under it,
the directory-to-`index.html` resolution with its trailing-slash redirect, and the fallback to
a site-root `404.html` with a plain 404 otherwise. The comments there record why each check
exists, including the acknowledged resolve-then-open race; carry them across rather than
rewriting them.

Two differences from the current code, both driven by the mode:

- Headers are set from `mode` immediately before each `sendFile`, per Part A.
- The site-relative path comes from the caller. On the forge host it is `wildcard(req)` as
  today; on a sites hostname the repository is the origin root, so it is the whole of
  `req.path`. Give `serveSite` the segments, or a small function that derives them from mode,
  rather than having it inspect the route shape.

`registerBrowse` keeps the route registration and calls `serveSite`; the `/:collection/:repo/site`
to `/site/` redirect at `src/browse.ts:595` also needs the Part B branch so it lands on the
site origin in one hop rather than two.

### Session resolution on a sites hostname

Defence in depth, on top of the fact that the sites middleware never asks for a viewer:

- `getViewer` (`src/session.ts:130`) returns `null` when `parseSiteHost` or
  `isUnderSitesHost` matches the request's hostname. It has `req` and `root` already, so it
  can read `loadConfig(root).sites.host` itself.
- `setSessionCookie` (`src/session.ts:55`) does nothing under the same condition. No caller
  should reach it from a sites hostname; make that structurally true rather than assumed.

### Links in the UI

`makeCtx` sets `hasSite` from `siteDir` (`src/web.ts:131`). Add the resolved site URL to the
same context, computed once with `siteHostFor`, and use it for the Site tab
(`src/views.ts:357`) and the mobile navigation link (`src/views.ts:570`). Both currently build
`${base}/site/`. When a sites host is configured and the repository is eligible, they link to
the site origin directly; otherwise they are unchanged.

## Part C: cookie hardening

In `src/session.ts`, replace the module-level `COOKIE_NAME` (`src/session.ts:21`) with a
function of the request:

```ts
const cookieName = (req: Request) =>
  req.protocol === 'https' ? '__Host-cofferdam_session' : 'cofferdam_session';
```

Browsers refuse a `__Host-`-prefixed cookie that carries a `Domain` attribute, so a sibling
subdomain cannot create a cookie by that name which reaches the vault. The prefix also
requires `Secure` and `Path=/`; `setSessionCookie` already sets `path: '/'` and sets `secure`
from `req.protocol`, so the conditional name is exactly consistent with when the prefix is
legal. A plain-http vault keeps the bare name.

`readSession` reads the prefixed name first and falls back to the bare one, so a session
minted before this change survives, and `clearSessionCookie` clears both names. The name is
referenced in only four places, all in `src/session.ts`.

Separately, in the write path: reject a state-changing request whose `Origin` header is
present and is not the request's own origin. It does nothing against same-origin script, and
Part A or B is what actually closes that, but it is a few lines and it catches proxy
misconfiguration. Put it beside the CSRF check so the two are read together.

## Documentation

- `docs/sites.md`. Rewrite the serving section. State that site content is untrusted code and
  that publishing a site is therefore a real privilege; state exactly what a sandboxed site
  cannot do, naming cookies, `localStorage`, `IndexedDB`, and service workers, and that a
  library touching `localStorage` unguarded will throw; describe `sites.host`, the
  `<repo>--<collection>` hostname, and the label-safety rule with the reason it refuses
  rather than lowercases; state plainly that per-repository hostnames isolate storage, DOM,
  and service worker scope but not cookies, because the cookie boundary is the registrable
  domain, and that a site wanting private state should use `localStorage` or IndexedDB.
- `docs/deploying.md`. A subsection under Fly.io on serving sites from their own hostname:
  the DNS records, the two `fly certs add` invocations, and the reason the wildcard needs
  DNS-01 while the plain subdomain does not. For a vault at `vault1.magland.org` on a Fly app
  named `vault1`, with `magland.org` on Cloudflare:

  | Type | Name | Content | Proxy |
  |---|---|---|---|
  | CNAME | `vault1` | `vault1.fly.dev` | DNS only |
  | CNAME | `*.vault1-sites` | `vault1.fly.dev` | DNS only |
  | CNAME | `_acme-challenge.vault1-sites` | as printed by `fly certs show` | DNS only |

  ```bash
  fly certs add vault1.magland.org -a vault1
  fly certs add '*.vault1-sites.magland.org' -a vault1
  fly certs show '*.vault1-sites.magland.org' -a vault1   # prints the DNS-01 target
  fly certs check '*.vault1-sites.magland.org' -a vault1
  ```

  Note the Cloudflare-specific trap, since it produces a certificate error rather than a
  clear failure: Universal SSL covers `example.com` and `*.example.com` only, one label deep,
  so a proxied `*.vault1-sites.magland.org` is not covered without Advanced Certificate
  Manager, and proxied wildcard DNS records are an Enterprise feature. All three records stay
  DNS only, which means no Cloudflare caching or WAF in front of the vault, consistent with
  the README's note that rate limiting is not implemented. Note also that the wildcard does
  not match the bare `vault1-sites.magland.org`, so that name needs its own record and
  certificate if it is ever to answer. This is one Fly app with two hostnames, not two apps.
  Sites hosts must differ per vault in any case, because two Fly apps cannot hold a
  certificate for the same hostname.
- `README.md`. The Sites bullet should say that sites are sandboxed by default and can be
  given their own hostname.

## Optional, only if it is cheap

`cofferdam deploy fly --sites-host <host>` writing the value into the vault's `config.json`,
and a `sites` line in `deploy show` next to the existing `lfs` line. The DNS and certificate
work cannot be done by the CLI, so this saves one edit and no more. Skip it if it complicates
`resolveSettings`, which currently reads live state back from Fly and has no notion of vault
config.

## Tests

`scripts/smoke.sh` already covers site serving at lines 1243-1271, including the symlink
escape. Extend it, keeping its `check` and `body_has` idiom. A `Host:` header is enough to
exercise Part B against `127.0.0.1`, since `trust proxy` is on; add a helper that takes a
host header alongside a URL if the existing ones cannot.

Part A, with no `sites.host` configured:

- the sandbox CSP is present on a site response, and names neither `allow-same-origin` nor
  `unsafe`
- `Access-Control-Allow-Origin: *` and `X-Content-Type-Options: nosniff` are present
- both are present on the site's own `404.html` response as well
- no `Set-Cookie` on any site response
- the forge's own pages still carry no `Access-Control-Allow-Origin`

Part B, with `sites.host` written into the vault's `config.json` as `sites.localhost`:

- `GET /pushed/created/site/` on the forge host answers 302 to
  `http://created--pushed.sites.localhost/`, and a request with a query string keeps it
- `GET /` with `Host: created--pushed.sites.localhost` serves the site's `index.html`, with
  `nosniff` and without the sandbox CSP
- `GET /assets/style.css` with that Host is a 404, not the forge stylesheet
- `GET /sub/real.txt` with that Host serves the file, and `/sub` redirects to `/sub/`
- the symlink escape from line 1269 is still refused on the sites hostname
- a request with a valid session cookie and that Host produces no signed-in chrome and no
  `Set-Cookie`
- `Host: sites.localhost` with no label, and `Host: a.b.sites.localhost`, both 404 without
  reaching the forge
- `Host: nosuchrepo--pushed.sites.localhost` 404s
- `POST /` with a site Host is 405
- a repository whose name is not label-safe, for instance the `my.site.thing` repository
  already created at line 696, is still served on the forge host under Part A and is not
  redirected

Part C:

- a login over plain http still sets `cofferdam_session` and the session works
- a login with `X-Forwarded-Proto: https` sets `__Host-cofferdam_session`, and a request
  presenting that cookie name is recognised
- a cookie under the old bare name is still accepted over https

`npm run build` must stay clean: `tsc` is configured to fail on unused locals and
parameters, which is the project's substitute for a linter.

## Order of work and acceptance

1. Part A and Part C. No configuration, no DNS, and they close the escalation on every
   existing deployment. `docs/sites.md` updated in the same change.
2. Part B: config, `src/siteshost.ts` with its tests, the `src/site.ts` extraction, the
   middleware, the redirect, the `getViewer` and `setSessionCookie` guards, the UI links,
   and `docs/deploying.md`.

Done means: `npm test` passes with the additions above; a vault with no `sites.host` serves
sites at their present URLs with the sandbox headers; a vault with one serves each eligible
repository's site from its own hostname with no session ever resolved there and with the
forge path redirecting; an ineligible repository still works, sandboxed, on the forge host;
and `docs/sites.md` states what a sandboxed site cannot do and that cookies are not isolated
between sites on one sites host.
