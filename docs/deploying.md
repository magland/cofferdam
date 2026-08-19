# Deploying a vault

A remote vault is the same server with a persistent disk and TLS in front; there is nothing else to it, since the vault directory is the entire state. On first start the server initializes the vault and prints the owner token; from then on all administration happens from your own machine, on the web or through the CLI after `cofferdam login`.

This document assumes you have already run a vault locally and want one other people can reach; [Getting started](getting-started.md) covers the local step and hands over here. It is organized by how far you intend to take it. `cofferdam deploy fly` puts a vault on the internet in one command, needing no machine of your own and no checkout of this repository. [A domain of your own](#a-domain-of-your-own) is the next step once the vault is something you mean to keep, and is also what gives static sites a hostname each. [A machine of your own](#a-machine-of-your-own) is the same container hosted yourself instead. [Limits](#limits) applies to all of them.

## Fly.io, in one command

Fly.io runs the container for you, and the CLI can put it there. Install [flyctl](https://fly.io/docs/flyctl/install/), run `fly auth login` once, then:

```bash
cofferdam deploy fly my-vault-name
```

Fly app names are globally unique and the name becomes the URL, so pick your own. That creates the app, a 10GB volume, and a single machine serving the vault over HTTPS at `https://my-vault-name.fly.dev`, and ends by printing the owner token:

```
==> Creating 'my-vault-name' in ewr
==> Creating a 10GB volume 'vault' in ewr
==> Setting the one-time owner token as a Fly secret
==> Deploying ghcr.io/magland/cofferdam:0.2.0
==> Waiting for the vault to answer

==> Ready: https://my-vault-name.fly.dev

The vault is initialized, and 'owner' owns it. This is its token, shown
here once and nowhere else: the server keeps only its hash, and the Fly secret it
was staged in cannot be read back. Keep it somewhere safe now.

  cofferdam_7acfa9fa32691cdbb53c3865fed61e59f61ab4eb948b4157d7e7fafc163fcb08

To administer the vault in a browser, open its sign-in page and give that token as
'owner':

  https://my-vault-name.fly.dev/login
...
```

That token is the way in, by either route, and it is the one thing to save before the terminal scrolls away. In the browser, open the `/login` page and sign in as `owner` with the token in the **Token** field: a vault has no passwords, so a username and a token is what the form asks for. From there the Admin page creates the users and the repositories, which is the usual way to bootstrap a fresh vault. To work from the CLI and from git instead, hand the same token to git's credential store once:

```bash
cofferdam login https://my-vault-name.fly.dev
```

That asks for the token without echoing it, checks it against the vault, and remembers the vault, after which `cofferdam whoami`, `cofferdam user add`, and `git push` need no token of their own (see [Not typing the token every time](cli.md#not-typing-the-token-every-time), and note that a login needs a credential helper configured).

The token is minted on your machine, not on the server: the deploy sets it as the `COFFERDAM_OWNER_TOKEN` secret, and the server adopts it when it initializes the empty vault, storing only its hash. So it is printed by the one process that ever had it, rather than read out of a log, and it cannot be recovered afterwards from either the server or the Fly secret, which can be written but never read back. The secret stays set and is ignored on every later start, since a vault is initialized once.

Note that the deploy stores nothing on your machine and logs you in to nothing. That is deliberate: `cofferdam login` is the one command that writes a credential, so a deploy from a machine that is not yours leaves no token behind on it.

Fly always terminates TLS in front of the app, so the deploy also tells the vault to believe the forwarded headers: it records `network.trustProxy: true` in the vault's `config.json` on the next start. That is what makes the clone URLs, the `Secure` cookies, and the per-address [limits](#limits) read the real scheme and address rather than the internal ones. It is only seeded, so changing it by hand afterwards sticks.

### Deploying updates, and changing settings

The same command deploys an update:

```bash
cofferdam deploy fly my-vault-name
```

Nothing about the deployment is kept on your machine. Fly already knows the region, the volume size, and the machine's shape, so each run reads them back from the live app and applies only what a flag changes. One flag therefore changes one thing:

```bash
cofferdam deploy fly my-vault-name --volume 50          # grow the disk
cofferdam deploy fly my-vault-name --vm-memory 1gb      # a bigger machine
cofferdam deploy fly my-vault-name --image ghcr.io/magland/cofferdam:main
```

The flags, all optional: `--region` (default `ewr`, and see `fly platform regions`), `--volume <gb>` (default 10), `--vm-size` (default `shared-cpu-1x`), `--vm-memory` (default `512mb`), `--org` for which Fly organization owns a new app, `--lfs-bucket` (below), and `--image <ref>` to deploy something other than the published image for your CLI's own version.

Two of these have limits worth knowing before you rely on them: Fly volumes can grow but never shrink, and a volume cannot move between regions, so `--volume` with a smaller number and `--region` pointing somewhere else are both refused rather than quietly ignored. Changing region means a new vault and copying the data across.

To see what is deployed, and whether the vault on it actually answers:

```bash
cofferdam deploy fly show my-vault-name
```

```
my-vault-name  https://my-vault-name.fly.dev

  machine   1857701b4de389  started  ewr  shared-cpu-1x, 512mb
  image     ghcr.io/magland/cofferdam:0.2.0
  volume    10GB in ewr (created)
  lfs       objects on the volume
  vault     answering, and you are 'owner' on it
  login     this is the vault cofferdam commands use
```

`cofferdam deploy fly destroy my-vault-name` removes the app, the volume, and with them the vault; it asks you to type the app name first (`--yes` skips the prompt, for a script that means it), and also drops the stored credential for a vault that no longer exists. Anything else is flyctl's job, and flyctl is already on your machine: `fly logs -a my-vault-name`, `fly ssh console -a my-vault-name` for a shell on the volume, and `fly certs` for [a domain of your own](#a-domain-of-your-own).

### LFS objects in a bucket

By default Git LFS objects live on the volume with everything else, which is the simplest arrangement and the easiest to back up. Passing `--lfs-bucket` on a deploy provisions a Tigris bucket instead:

```bash
cofferdam deploy fly my-vault-name --lfs-bucket
```

Tigris' secrets are the ones the server already reads, so there is nothing further to configure (see [Git LFS](lfs.md)). Note that this provisions a billable resource in your Fly organization, and that `deploy fly destroy` leaves the bucket alone: destroying it, and its contents, is `fly storage destroy <name>`.

### What the deploy does, in flyctl terms

There is nothing magic in the above, and no state anywhere but Fly. The equivalent by hand, if you would rather run it yourself or adapt it to another host:

```bash
fly apps create my-vault-name
fly volumes create vault --app my-vault-name --region ewr --size 10 --yes
fly secrets set COFFERDAM_OWNER_TOKEN=cofferdam_... --app my-vault-name --stage
fly deploy --app my-vault-name --config fly.toml --image ghcr.io/magland/cofferdam:0.2.0 --ha=false
cofferdam login https://my-vault-name.fly.dev
```

The config the CLI generates for that deploy, and writes to a temporary directory rather than into your project:

```toml
app = "my-vault-name"
primary_region = "ewr"

[mounts]
  source = "vault"
  destination = "/vault"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0
  [http_service.concurrency]
    type = "requests"
    hard_limit = 250
    soft_limit = 200

[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory = "512mb"
```

Note `--ha=false`, and `min_machines_running = 0` with auto-start: a vault is a directory on a single volume, so this app runs as exactly one machine. Two machines would mean two volumes and two vaults that silently diverge. For the same reason, a busier vault wants a bigger machine rather than more of them. The machine stops when idle and starts again on the next request, which costs a few seconds on the first request after a quiet spell.

## A domain of your own

A vault on `my-vault-name.fly.dev` is a real HTTPS URL and there is nothing wrong with keeping it. Moving to a name you own buys two things. The vault's address stops naming the host it happens to run on, so it can move later without breaking everyone's remotes. And static sites can be given a hostname each, instead of sharing the vault's under a sandbox that costs them cookies, storage, and service workers.

Those are separate pieces of work, in that order, and the second is optional. Both are DNS records and certificates, which is the part the CLI cannot do for you: `cofferdam deploy fly` never touches your domain.

The examples below are a vault at `vault1.magland.org`, on a Fly app named `vault1`, with `magland.org` on Cloudflare. Another DNS provider differs only in where the records are typed, and another host only in how the certificate is obtained.

### The vault's own hostname

One record and one certificate:

| Type | Name | Content | Proxy |
|---|---|---|---|
| CNAME | `vault1` | `vault1.fly.dev` | DNS only |

```bash
fly certs add vault1.magland.org -a vault1
fly certs check vault1.magland.org -a vault1
```

Fly validates this one over HTTP-01, which it can answer itself because requests for that name already reach the app, so there is nothing further to add once the CNAME resolves.

Nothing in the vault has to be told its own name. Clone URLs, redirects, and cookies are all built from the host of the request, so the vault answers correctly on both names at once. That is what makes the change safe to do while people are using it: `.fly.dev` keeps working, and remotes can be re-pointed at leisure with `git remote set-url origin https://vault1.magland.org/alice/webapp`. Log in again under the new name, `cofferdam login https://vault1.magland.org`, so that the CLI and git use it too.

### A hostname for each site

By default a repository's static site is served from the vault's own hostname and sandboxed, which costs it cookies, storage, and service workers (see [Sites](sites.md)). Giving each site a real origin means a wildcard hostname and a certificate for it, which is more DNS work than the plain name above:

| Type | Name | Content | Proxy |
|---|---|---|---|
| CNAME | `*.vault1-sites` | `vault1.fly.dev` | DNS only |
| CNAME | `_acme-challenge.vault1-sites` | as printed by `fly certs show` | DNS only |

```bash
fly certs add '*.vault1-sites.magland.org' -a vault1
fly certs show '*.vault1-sites.magland.org' -a vault1   # prints the DNS-01 target
fly certs check '*.vault1-sites.magland.org' -a vault1
```

A wildcard cannot be validated over HTTP-01, since there is no single name to answer for, so it needs DNS-01. That is why the `_acme-challenge` record exists, and why `fly certs show` has to be run first to learn what to put in it.

Then set the host in the vault's `config.json`, which lives on the volume rather than in the image:

```bash
fly ssh console -a vault1 -C 'cat /vault/config.json'   # what is there now
fly ssh console -a vault1                               # then edit /vault/config.json
```

```json
{
  "network": { "trustProxy": true },
  "sites": { "host": "vault1-sites.magland.org" }
}
```

Keep whatever `deploy fly` seeded there, which is `network.trustProxy`. Leave the file owned by `node`, the user the server runs as. No restart is needed: the config file is re-read when it changes, and a value that is not a plausible hostname is ignored in favour of the default, so a typo serves sites from the vault's own hostname as before rather than from a name no certificate covers.

This is one Fly app with two hostnames, not two apps. Sites hosts must differ per vault in any case, because two Fly apps cannot hold a certificate for the same hostname.

A Cloudflare-specific trap, since it produces a certificate error rather than a clear failure: Universal SSL covers `example.com` and `*.example.com` only, one label deep, so a proxied `*.vault1-sites.magland.org` is not covered without Advanced Certificate Manager, and proxied wildcard DNS records are an Enterprise feature. All three records stay DNS only, which means no Cloudflare caching or WAF in front of the vault. Note also that a wildcard does not match the bare `vault1-sites.magland.org`, so that name needs its own record and certificate if it is ever to answer; without one it simply does not resolve, and the vault answers a minimal 404 on it if it does.

Not every repository is eligible for a hostname of its own, because not every legal repository name is a legal DNS label; an ineligible one keeps being served on the forge host under the sandbox. [Sites](sites.md) gives the rule, and describes what a per-site origin does and does not isolate.

## A machine of your own

On a host that already has Node and git, the published package needs no checkout:

```bash
npm install -g @magland/cofferdam
cofferdam serve /srv/vault --host 0.0.0.0 --port 3000
```

That leaves keeping the process alive to the host's service manager. The container recipe in this repository does that part for you, and carries git in the image, so it is the shorter path on a machine with Docker:

```bash
docker build -t cofferdam .
docker run -d --name cofferdam -p 3000:3000 -v ./vault:/vault cofferdam
docker logs cofferdam    # copy the one-time owner token
```

This serves plain HTTP, which is fine on a trusted or private network (a Tailscale or WireGuard address, say) but not on the open internet, since tokens travel as Basic-auth passwords and session cookies are only marked `Secure` behind HTTPS.

With a domain name pointed at the machine, the included `docker-compose.yml` adds Caddy for automatic HTTPS:

```bash
DOMAIN=cofferdam.example.org docker compose up -d
docker compose logs cofferdam            # the owner token
cofferdam login https://cofferdam.example.org
cofferdam user add alice --scope 'alice/*'
git clone https://cofferdam.example.org/alice/some-repo
```

The server honors `X-Forwarded-*` headers when the vault says a proxy is in front, which is what makes clone URLs, cookies, and the web UI correct behind one. Caddy is such a proxy, so set it:

```json
{
  "network": { "trustProxy": true }
}
```

It is false by default, and deliberately so: `X-Forwarded-For` is supplied by the client, so on a vault exposed directly any visitor could claim any address, which defeats every per-address limit below and lets one attacker fill the limiter's key space. Set it only when a reverse proxy you control is the only way in. `cofferdam deploy fly` sets it for you, since Fly always terminates TLS in front.

Backing up a vault is copying a directory. Moving it to another host, or from your laptop to the cloud, is copying it there. Note that a vault on the open internet is readable by anyone, so say so in your own deployment notes.

## Limits

Two kinds of load are bounded in the server, and a third is the reverse proxy's job.

**Concurrent git work.** A clone, a push, a content search, a file listing, and a source archive each spawn git, and each holds a subprocess and a socket for as long as the client cares to read. Counting requests per minute does not bound that, because the requests are slow rather than frequent, so what is bounded is how many may run at once. There are four separate gates, so that a flood of anonymous clones cannot stop an authorized push, which is the operation whose failure costs a person their work. Beyond a gate a request waits briefly and is then refused with `503` and a `Retry-After`.

**Failed credential checks.** `/login`, the API, git push, Git LFS, and the runner endpoints are throttled per address, and per address and username together, but only on failure: a working credential is never throttled however often it is used, which matters because a runner calls the vault continuously with a valid one. Refusals are `429` with a `Retry-After`. Nothing is ever locked per account, because anyone could then lock an owner out by presenting wrong tokens for their username; the source is throttled, never the target.

**Ordinary traffic** has a coarse per-address ceiling, so that one misbehaving crawler cannot saturate the process with cheap page renders. It is high on purpose: one page load of a static site can be dozens of requests, and a limit that makes a site feel broken gets turned off and takes the useful limits with it. `/api/runner/*`, `/assets/*`, and the favicons are exempt.

**Connection limits, request timeouts, slow-loris defence, and body-size limits** are not here. They belong to the reverse proxy, which the `docker-compose.yml` deployment already has, and duplicating them in the server would mean two places to get them wrong.

The numbers live in `config.json`:

```json
{
  "limits": {
    "requestsPerMinute": 600,
    "authFailures": 10,
    "clone": 4,
    "push": 4,
    "search": 2,
    "tree": 4
  }
}
```

Those are the defaults, chosen for the small VPS this document describes. `requestsPerMinute` is per address over everything not exempt, and `0` disables it, which is what a vault behind a proxy that already does this wants. `authFailures` is failed credential checks per address per username per fifteen minutes, and `0` disables it; the more generous per-address window that catches an attacker spreading attempts over many usernames is derived from it rather than configured, so there is one number to think about. The four concurrencies are git subprocesses in flight per class. Queue depths and timeouts are constants in the code rather than settings.

Unlike `theme` and `ci`, these are read **once at startup**, because they hold live counts and slot tallies that cannot be rebuilt per request without discarding them. Changing them needs a restart. The same is true of `network.trustProxy`, which is what makes any per-address limit meaningful in the first place: without it the address a limit is charged to is whatever the client said it was.

Two limitations, stated plainly rather than engineered around. The counters live in process memory and nowhere else, because rate-limit state is high-frequency and worthless once stale and does not belong in a vault directory whose whole design is durable plain files. So a restart forgives every offender, and two servers pointed at one vault count separately.
