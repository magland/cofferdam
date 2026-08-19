# Spec: rate limiting and abuse controls

This is an implementation handoff document, not user documentation. It describes a change to be made to cofferdam; delete it once the change has landed and `docs/deploying.md` describes the result.

## The problem

`docs/deploying.md:154` says that rate limiting and abuse controls are not implemented, which is accurate. A vault on the open internet today will answer as many requests as arrive, and three of the ways it answers them are worth bounding for different reasons.

**Unbounded git subprocesses.** `runService` (`src/githttp.ts:155`) spawns a `git upload-pack` per anonymous `POST /:collection/:repo/git-upload-pack`, and `advertise` (`src/githttp.ts:139`) spawns another per `/info/refs`. Content search runs `git grep` through `repo.search` (`src/find.ts:106`), the file finder runs `ls-tree -r` over an entire tree (`src/find.ts:34`), and source downloads stream `git archive` (`src/git.ts:457`, from `src/browse.ts:383`). None of these has a cap on how many may be in flight. `execGit`'s `maxBuffer` is 256 MB (`src/git.ts:3`), so a handful of concurrent `ls-tree` calls on a large repository is already a memory problem, and clones are worse because each holds a subprocess and a socket for as long as the client cares to read. This is the vector that takes a small VPS down, and it is not fixed by counting requests per minute, because the requests are slow rather than frequent. What bounds it is a limit on how many may run at once.

**Unthrottled credential checking.** `POST /login` (`src/webops.ts:161`), `requireApiAuth` (`src/api.ts:27`), `requireAdmin` (`src/ci/api.ts:30`), `checkPushAuth` (`src/githttp.ts:48`, reused by LFS at `src/lfs.ts:116`), and `requireRunner` (`src/ci/api.ts:49`) will each check an unlimited number of wrong credentials. Tokens come from `mintToken` (`src/vault.ts:106`) and are not guessable, so this is not a spec for closing a hole that is open today. Two things still argue for throttling it. A vault's own `.secret`, its runner tokens, and any token an operator shortened or typed by hand are not covered by that argument. And an endpoint that will check a credential as fast as it is asked is an amplifier: each check is a `loadVault` and a scrypt or similar hash, so the cheapest request an attacker can send is one of the more expensive ones the server can answer.

**No ceiling on ordinary traffic.** A single misbehaving crawler can saturate the process with cheap page renders. This is the least dangerous of the three and needs the bluntest instrument.

Underneath all three is a prerequisite. `app.set('trust proxy', true)` at `src/server.ts:30` is unconditional, so `req.ip` is read from a client-supplied `X-Forwarded-For` header. That is correct behind Caddy or Fly, and wrong on a vault exposed directly, where any per-IP limit is defeated by one fabricated header and the limiter's own key space becomes unbounded. Nothing keyed on `req.ip` is worth building until this is settled.

## What this change delivers

Four parts, in this order:

- **Part A, a trustworthy client identity.** `trust proxy` becomes configurable, and one function owns the question of what to key a limit on. Nothing else in this spec works without it.
- **Part B, the primitives.** A new `src/limit.ts` with a fixed-window counter and a concurrency gate. No new dependency.
- **Part C, concurrency caps.** The gate applied to the routes that spawn git. This is the part with real consequences today and it can land alone.
- **Part D, request and failure limits.** The counter applied to failed authentication, and a coarse per-IP ceiling on everything else.

Parts A and C are the ones worth landing first, together. Part D is cheap once B exists.

### Not in scope

- Any counter that survives a restart or is shared between processes. Rate-limit state is high-frequency, worthless once stale, and does not belong in a vault directory whose whole design is plain files written durably (`src/atomic.ts`). Counters live in process memory and nowhere else. Two servers pointed at one vault count separately, and a restart forgives every offender. Both are documented limitations, not bugs to engineer around.
- Locking or disabling an account after failed logins. Anyone could then lock out an owner by presenting wrong tokens for their username. Throttle the source, never the target.
- Per-user or per-token quotas, billing-style budgets, and any notion of a plan. There are no accounts for anonymous readers to have quotas against.
- Connection limits, request timeouts, slow-loris defence, and body-size limits beyond the per-route ones already set by `urlencodedForm` (`src/web.ts:34`). These belong to the reverse proxy, which the `docker-compose.yml` deployment already has. Document the division instead of duplicating it.
- A dependency on `express-rate-limit`. It is roughly the code in Part B plus a store abstraction for backends this project does not have, and its defaults would all be overridden.
- Blocklists, `403` for named addresses, CAPTCHA, and proof of work.

## Part A: a trustworthy client identity

### Configuration

Extend `VaultConfig` in `src/config.ts`:

```ts
export interface NetworkConfig {
  /**
   * Whether X-Forwarded-For and X-Forwarded-Proto may be believed. True only
   * when a reverse proxy you control is the only way in.
   */
  trustProxy: boolean;
}
```

Default `false`. Follow the validation discipline already in `loadConfig`: a value that is not a boolean is ignored and the default used.

The default is a behaviour change, so it needs the two places that create a public vault to set it. `cofferdam deploy fly` writes `network.trustProxy: true` into the new vault's `config.json`, because Fly always terminates TLS in front. `docker-compose.yml` ships Caddy in front, so `docs/deploying.md` must tell that reader to set it, and the Caddy subsection must say why. A vault on `127.0.0.1` with nothing in front, which is the `npx` quick start, wants the default.

`createApp` reads it once at startup rather than per request:

```ts
app.set('trust proxy', loadConfig(root).network.trustProxy);
```

Startup, not per request, is a deliberate departure from the theme and CI config, which are re-read so that hand-editing takes effect live. Express resolves `trust proxy` when the `Request` prototype is built, so it is not a per-request decision to make, and changing whether the internet is trusted is a restart-worthy event in a way that changing a colour scheme is not. Say so in a comment where the existing comment at `src/server.ts:28-30` now sits, and keep that comment's point: the forwarded headers are what make clone URLs and `Secure` cookies correct.

### The key

One function, in `src/limit.ts`, is the only thing any limiter keys on:

```ts
/**
 * The address a limit is charged to. Express's req.ip reads
 * X-Forwarded-For when trust proxy is set, which is client-supplied, so it is
 * used only when the operator has said a proxy is in front. Otherwise the
 * socket's peer address is the only thing an attacker cannot choose.
 */
export function clientKey(req: Request): string;
```

When `req.app.get('trust proxy')` is falsy it returns `req.socket.remoteAddress ?? 'unknown'`; otherwise `req.ip ?? req.socket.remoteAddress ?? 'unknown'`.

Normalise before keying, or an attacker gets a fresh bucket per spelling of one address: lowercase, and strip a `::ffff:` IPv4-mapped prefix. Do not aggregate IPv6 addresses into a /64. It is the more effective choice against a single host with a routed prefix and the more damaging one behind a CGNAT or a university, and guessing wrong is worse than the coarse behaviour.

`clientKey` must be used by every limiter in Parts C and D. No route may key on `req.ip` directly.

## Part B: the primitives

A new module, `src/limit.ts`. Both primitives return a decision rather than writing a response, the way `checkPushAuth` (`src/githttp.ts:44-46`) does, because the callers render refusals in four content types: HTML for the web, JSON for the API, plain text for git, and LFS's own JSON shape.

### The counter

```ts
export interface LimitDecision {
  ok: boolean;
  /** Seconds to put in Retry-After, when ok is false. */
  retryAfter: number;
}

export interface Limiter {
  /** Charge one event to key and say whether it is within the limit. */
  hit(key: string): LimitDecision;
  /** Whether key is currently over the limit, charging nothing. */
  check(key: string): LimitDecision;
}

export function createLimiter(opts: { limit: number; windowMs: number; maxKeys: number }): Limiter;
```

A `Map<string, { count: number; resetAt: number }>`, fixed windows. A fixed window lets twice the limit through across a window boundary; a token bucket would not, and buys smoothness that none of these limits need. Do not build the sliding window.

Two things the map must do that are easy to leave out. Expired entries are swept on write, amortised over a bounded number of entries per call so that one request cannot pay for a very large map. And `maxKeys` is a hard ceiling, because an unbounded map keyed on anything an attacker influences is itself a memory-exhaustion vector.

When the map is at `maxKeys` and a sweep frees nothing, `hit` on a key not already present returns `ok: true` and logs once per window. That is failing open, and it is the right way round: a limiter that refuses everyone the moment it is full has become the outage it exists to prevent. Part A is what makes this rare, by bounding the key space to real peers. Note this in the module comment, since a reader will otherwise take it for an oversight. Part C describes how the authentication limiter degrades rather than failing open.

### The gate

```ts
export interface Gate {
  /**
   * Wait for a slot, or refuse. Resolves to a release function, or null when
   * the queue is already full. Never rejects.
   */
  enter(): Promise<(() => void) | null>;
  readonly busy: number;
  readonly queued: number;
}

export function createGate(opts: { concurrency: number; queue: number; timeoutMs: number }): Gate;
```

A counter of slots in use and a FIFO of waiters. `enter` takes a slot if one is free, queues if the queue is shorter than `queue`, and resolves `null` immediately otherwise. A waiter that has been queued for longer than `timeoutMs` resolves `null` and is dropped, so a request never waits indefinitely for work that a client has probably given up on.

The release function must be idempotent, and every caller must invoke it from a place that runs on every path out of the request, including a client disconnect. An aborted clone is ordinary traffic, not an error, and a gate that leaks a slot per abort stops answering after `concurrency` of them. The idiom, applied in Part C:

```ts
const release = await gate.enter();
if (!release) return refuse(res);
let released = false;
const done = () => { if (!released) { released = true; release(); } };
res.on('close', done);
try { ... } finally { done(); }
```

`res.on('close')` fires on both a completed and an aborted response, which is why `done` must be idempotent rather than merely called once.

## Part C: concurrency caps on git subprocesses

Four gates, created once in `createApp` and passed to the registration functions that need them, the way `lfs` and `engine` already are (`src/server.ts:88-96`). Put them in one object so a fifth is a one-line addition:

```ts
export interface Gates {
  clone: Gate;   // git-upload-pack, both advertise and the RPC
  push: Gate;    // git-receive-pack
  search: Gate;  // git grep
  tree: Gate;    // ls-tree for the file finder, git archive for source downloads
}
```

Separate gates and not one, so that a flood of anonymous clones cannot stop an authorized push, which is the operation whose failure costs a person their work. For the same reason `push` is entered only after `requirePushAuth` has succeeded: an unauthenticated request must not be able to occupy a slot in the gate that authorized users depend on. `clone` is entered before anything expensive and after `findRepo`.

Defaults, with `queue` and `timeoutMs` chosen so that a brief burst waits rather than failing:

| Gate | concurrency | queue | timeoutMs |
|---|---|---|---|
| `clone` | 4 | 16 | 10000 |
| `push` | 4 | 16 | 30000 |
| `search` | 2 | 8 | 5000 |
| `tree` | 4 | 16 | 10000 |

These are for a small VPS, which is the deployment the README describes. They are configurable per Part D's `limits` block.

Call sites:

- `advertise` and `runService` in `src/githttp.ts`, under `clone` for `git-upload-pack` and `push` for `git-receive-pack`. Both functions already own the subprocess lifecycle, so both are the right place to hold the slot; release on the child's `close`, not on the route handler returning, since `runService` pipes and returns before the child exits.
- `repo.search` in `registerSearch` (`src/find.ts:106`), under `search`.
- The `ls-tree` in `registerFind` (`src/find.ts:34`) and `archiveTo` in the archive route (`src/browse.ts:383`), under `tree`. The archive slot is held until the stream ends, which is what the gate is for.

Refusals:

- git routes: `503` with `Retry-After` and a plain-text body. git shows the body to the user for a 503 on the RPC, so make it one sentence saying the server is busy and to try again. Do not use `429` here; git's own error surface reads better with 503, and the condition is server capacity rather than a client quota.
- The web routes: `503` through `views.errorPage(503, ...)`, so the page carries the vault's chrome, with `Retry-After` set. `send404`'s neighbour in `src/web.ts` is the place for a small `sendBusy` helper.

The two caps that already exist, `MAX_PATHS` (`src/find.ts:20`) and the result caps at `src/find.ts:49-50`, are unaffected and stay. They bound one response; the gate bounds how many at once.

## Part D: request and failure limits

### Failed authentication

One limiter for the whole vault, charged only on failure, so a working credential is never rate limited no matter how often it is used. This matters for `/api/runner/*`, which the runner calls continuously: heartbeats at `src/ci/api.ts:206` and log and status posts around it, all with a valid token, none of which may be throttled.

```ts
export interface AuthLimiter {
  /** Whether this request may attempt a credential at all. */
  allow(req: Request, username: string | null): LimitDecision;
  /** Record a failed attempt. Call only when the credential was wrong. */
  fail(req: Request, username: string | null): void;
}
```

Two windows underneath, both charged by `fail` and both consulted by `allow`:

| Key | limit | windowMs | maxKeys |
|---|---|---|---|
| `${clientKey(req)}\0${username}` | 10 | 900000 | 20000 |
| `clientKey(req)` | 50 | 900000 | 20000 |

The coarse per-address window is what catches an attacker spreading attempts over many usernames, and it is deliberately the more generous of the two so that a shared address behind NAT is not cut off by one person mistyping a token. `username` is null for bearer and runner tokens, where there is no username in the request; those charge the fine-grained window under a fixed sentinel and rely mostly on the coarse one.

The fine-grained map is the one an attacker can grow, by varying the username. When it is full, `allow` falls back to the coarse decision alone rather than failing open, and the coarse map's key space is bounded by real peers. Say this in the code: it is the reason two windows exist rather than one.

Call sites, each refusing in its own content type before it checks anything:

- `POST /login` (`src/webops.ts:161`). `allow` with the submitted username before `authenticate`; `fail` when `authenticate` returns null. Refuse by re-rendering `forms.loginPage` with `429`, `Retry-After`, and a message that says too many attempts and names the wait in minutes. Keep the existing generic failure message for a wrong credential exactly as it is (`src/webops.ts:170-171`): the refusal must not become a way to learn whether a username exists.
- `requireApiAuth` (`src/api.ts:27`) and `requireAdmin` (`src/ci/api.ts:30`). `allow` with null before `authenticateToken`, `fail` after it returns null, refuse with `apiError(res, 429, ...)` plus `Retry-After`. A missing `Authorization` header is not a failed attempt and must not be charged, or a browser hitting an API path with no header would consume a real client's budget.
- `checkPushAuth` (`src/githttp.ts:48`). It is a pure function returning a result, so extend `PushAuthCheck`'s status union with `429` and let the two callers render it; `requirePushAuth` in `src/githttp.ts` and the LFS path at `src/lfs.ts:116` already branch on status. Charge on `authenticate` returning null (`src/githttp.ts:69`), not on missing Basic auth, since git's first request to a push endpoint is unauthenticated by protocol and always will be.
- `requireRunner` (`src/ci/api.ts:49`). Same shape as `requireAdmin`.

### The coarse ceiling

One limiter over everything else, keyed on `clientKey` alone, registered in `createApp` after the theme middleware and before the asset routes.

Default 600 requests per minute per address, `maxKeys` 20000. That is high on purpose. One page load of a static site under `/:collection/:repo/site/` can be dozens of requests, and a limit that makes a site feel broken will be turned off and take the useful limits with it. Refuse with `429`, `Retry-After`, and `views.errorPage`.

Exempt by prefix, checked before the counter is charged:

- `/api/runner/*`, for the reason above. The runner's long poll (`src/runner/client.ts:222`) and its log posts are legitimately high-volume from one address, and a runner sharing an address with a person must not throttle either.
- `/assets/*` and `/favicon.svg`, which are served from memory or a package directory and are cheaper to answer than to count.

Setting the limit to 0 disables the coarse limiter entirely, which is what a vault behind a proxy that already does this wants.

### Configuration

One block in `VaultConfig`, validated field by field in `loadConfig` with each bad value falling back to its own default:

```ts
export interface LimitsConfig {
  /** Requests per minute per address, over everything not exempt. 0 disables. */
  requestsPerMinute: number;
  /** Failed credential checks per address per username, per 15 minutes. 0 disables. */
  authFailures: number;
  /** Concurrent git subprocesses, per class. */
  clone: number;
  push: number;
  search: number;
  tree: number;
}
```

Defaults `{ requestsPerMinute: 600, authFailures: 10, clone: 4, push: 4, search: 2, tree: 4 }`. The coarse per-address failure window is derived as `authFailures * 5` rather than configured, so there is one number to think about. Queue depths and timeouts are constants in `src/limit.ts`, not configuration; nobody tunes those without reading the code, and they can be promoted later if anyone asks.

Like `trustProxy`, these are read once at startup, because the limiters and gates hold live state that cannot be rebuilt per request without discarding the counts. Note in `docs/deploying.md` that changing them needs a restart, which is the one place this block differs from `theme` and `ci`.

## Documentation

- `docs/deploying.md`. Replace the sentence at line 154. It should say what is now bounded and what is not: concurrent git work and failed credential checks are limited in the server, and connection limits, request timeouts, and body limits are the reverse proxy's job. Document the `limits` block with its defaults and the restart requirement. Document `network.trustProxy` as the setting that makes per-address limits meaningful, that it must be true behind Caddy or Fly and false otherwise, and that setting it true on a directly exposed vault lets any client claim any address. The Caddy subsection and the Fly subsection each need one line pointing at it, and the Fly section should say `deploy fly` sets it. State the two limitations plainly: counters are in memory, so a restart clears them and two servers pointed at one vault count separately.
- `README.md`. The Deploying paragraph mentions TLS and a persistent disk; it can mention that a public vault also wants `network.trustProxy` set. Nothing else in the README needs to change, and the feature list should not grow a bullet for this.
- `SPEC-site-isolation.md:328` says the DNS-only records mean no Cloudflare caching or WAF in front of the vault, "consistent with the README's note that rate limiting is not implemented". If that spec has landed, correct the clause; if it has not, whoever lands it should.

## Tests

Extend `scripts/smoke.sh`, keeping its `check`, `body_has`, and `-D "$TMP/headers"` idioms. The server it starts is a single process on `127.0.0.1` with no proxy, so `trust proxy` is false there and `clientKey` is the loopback address, which makes every limit trivially reachable from the test.

Rate limits and a smoke test are awkward together, because a test that trips a limit leaves the limiter tripped for everything after it. Two ways to keep that from turning into a flaky suite, and the implementation should take the first: write a `limits` block into the vault's `config.json` and restart the server for a small block of limit tests at the end of the run, after the existing checks. The suite already starts the server itself, so a second start with different configuration is a known quantity. Do not reorder the existing checks around a limiter, and do not add a test-only endpoint for resetting counters.

With `authFailures` set to 2:

- the third wrong login from the same address is `429`, and carries `Retry-After`
- the `429` body says nothing about whether the username exists, and the first two still return `401` with the existing generic message
- a correct login still succeeds while a different username is throttled, and a correct login is not charged: repeat it more than `authFailures` times and it keeps returning `302`
- `GET /api/whoami` with a wrong bearer token returns `401` then `429`; with no `Authorization` header it returns `401` however many times it is asked

With `requestsPerMinute` set to 5:

- a sixth request to the home page is `429` with `Retry-After`
- `GET /assets/style.css` and `/favicon.svg` still return `200` past the limit
- with `requestsPerMinute` set to 0, no number of requests is refused

With `clone` set to 1 and `search` set to 1:

- a clone still works, which is the check that the gate releases its slot: `git clone` the example repository twice in sequence and both succeed
- an aborted clone does not leak the slot: start a clone, kill it, then clone again successfully. This is the regression that the idempotent release exists for and it is worth the awkwardness of writing.
- concurrent searches beyond the gate either succeed or return `503`, never hang past the queue timeout

Unit-level checks for `src/limit.ts` are not something this project has a harness for, and adding one for two hundred lines is not the trade to make. The `maxKeys` fallback path in particular is not reachable from a smoke test; leave it covered by the comment explaining why it fails open.
