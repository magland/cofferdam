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

The flags, all optional: `--region` (default `ewr`, and see `fly platform regions`), `--volume <gb>` (default 10), `--vm-size` (default `shared-cpu-1x`), `--vm-memory` (default `512mb`), `--org` for which Fly organization owns a new app, `--lfs-bucket` (below), and `--image <ref>` or `--from-source` (below) to deploy something other than the published image for your CLI's own version.

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

### Updating on a schedule

A vault does not update itself, and Fly will not update it for you. The tag a deploy names is resolved to a digest when the machine is created, so a restart, an autostart after an idle spell, and a move to another host all bring back the image that deploy pinned. Updating is a deploy, every time.

What makes that worth automating is that a deploy needs nothing of yours but a Fly credential. It reads the region, the volume, and the machine's shape back off the live app, writes nothing on the machine it runs from, and on an app that already has a machine it mints no owner token and prints nothing secret. So the command that updates a vault by hand is also the whole of a scheduled job somewhere you are not:

```yaml
# .github/workflows/update-vault.yml, in a repository of your own
name: update-vault
on:
  schedule: [{ cron: '17 9 * * 1' }]     # Mondays, 09:17 UTC
  workflow_dispatch:
jobs:
  redeploy:
    runs-on: ubuntu-latest
    steps:
      - uses: superfly/flyctl-actions/setup-flyctl@master
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: npx --yes @magland/cofferdam@latest deploy fly my-vault-name
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

Run the newest CLI and pass no `--image`, rather than pinning `--image ...:latest` on an older one. The CLI asks for the image tag matching its own version, and a version tag exists only because the release that produced it was built and smoke-tested first, so what reaches the vault is a version that passed. It also leaves `cofferdam deploy fly show` reporting a version rather than `latest`, which is the difference between knowing what is running and knowing only when it was last deployed.

flyctl reads `FLY_API_TOKEN` from the environment, so nothing needs to be logged in on the runner. `fly tokens create deploy -a my-vault-name` mints the narrowest token that can do this. Note that a deploy starts by asking `fly auth whoami` and stops if that cannot answer, so if a deploy-scoped token is refused there, an org-scoped one from `fly tokens create org <org>` is the fallback.

A systemd timer, a launchd job, or a cron line on any machine you keep running does the same thing with the same command. GitHub Actions is only the version of it that needs no machine of yours.

Two costs, worth choosing deliberately rather than discovering. A vault is one machine on one volume, so every update is a restart, and a restart cuts whatever clone or push was in flight; weekly at a quiet hour is the cadence to want, and nightly buys nothing, since the published tags move only when a release is cut. And an unattended deploy has no notion of rolling back, so if a release does break something the repair is a deploy that pins the previous version by hand:

```bash
cofferdam deploy fly my-vault-name --image ghcr.io/magland/cofferdam:0.2.0
```

### Deploying your own build

By default the image deployed is the published one matching the version of the CLI you ran, which means waiting for a release before a change of your own can reach a vault. `--from-source` builds the image from the checkout you are running instead:

```bash
git clone https://github.com/magland/cofferdam && cd cofferdam
npm install && npm run build
node dist/index.js deploy fly my-vault-name --from-source
```

That runs `fly deploy` in the checkout, so the build context is the checkout and Fly builds the `Dockerfile` that is in it. Nothing is published anywhere in the process: the image goes to the Fly registry for that app alone. Everything else about the deploy is unchanged, so the volume, the vault on it, and the settings the app already has all survive as they do for any other update.

The build happens on a Fly builder machine, which needs no Docker on your side and which Fly provisions on first use. `--local-build` uses this machine's Docker daemon instead and pushes the result:

```bash
node dist/index.js deploy fly my-vault-name --from-source --local-build
```

Local is usually faster to iterate with and slower to finish, since the finished image is uploaded rather than the source. Either way the same `Dockerfile` runs `npm ci` and `npm run build` inside the image, so what gets deployed is built from the source in your checkout and not from your `node_modules` or your local `dist` (a `.dockerignore` keeps both out of the context, along with `.git` and any `example-root` you have lying about). A dirty working tree is deployed as it stands, uncommitted changes included, which is the point but is worth remembering.

`--from-source` and `--image` contradict each other and passing both is refused. After a source build `deploy fly show` reports an image like `registry.fly.io/my-vault-name:deployment-01J…` rather than a version tag, which is how to tell one from a released deploy at a glance.

This is meant for trying a change against a real vault. For anything you mean to keep, tagging a release and deploying the published image leaves a record of what is running.

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

The examples below are a vault at `vault.example.org`, on a Fly app named `my-vault-name`, with `example.org` at some DNS provider. Substitute your own throughout.

### The vault's own hostname

Three commands, in this order:

```bash
fly certs add vault.example.org -a my-vault-name
fly certs setup vault.example.org -a my-vault-name
fly certs check vault.example.org -a my-vault-name
```

`fly certs setup` is the one that does the work of telling you what to do: it looks at the app and prints the exact DNS records to create for that name. Take them from there rather than guessing, since which records they are depends on the app, and a plausible-looking `CNAME` to `my-vault-name.fly.dev` is not reliably the right answer. Add what it prints at your DNS provider, then run `fly certs check` until the certificate is issued, which is usually a minute or two after the records resolve.

Nothing in the vault has to be told its own name. Clone URLs, redirects, and cookies are all built from the host of the request, so the vault answers correctly on both names at once. That is what makes the change safe to do while people are using it: `.fly.dev` keeps working, and remotes can be re-pointed at leisure with `git remote set-url origin https://vault.example.org/alice/webapp`. Log in again under the new name, `cofferdam login https://vault.example.org`, so that the CLI and git use it too.

### A hostname for each site

By default a repository's static site is served from the vault's own hostname and sandboxed, which costs it cookies, storage, and service workers (see [Sites](sites.md)). Giving each site a real origin means a wildcard hostname, and a wildcard certificate is more work than the plain name above:

```bash
fly certs add '*.vault-sites.example.org' -a my-vault-name
fly certs setup '*.vault-sites.example.org' -a my-vault-name
fly certs check '*.vault-sites.example.org' -a my-vault-name
```

A wildcard cannot be validated over HTTP-01, since there is no single name for the app to answer on, so it needs DNS-01. That is the difference from the plain name, and it means `fly certs setup` asks for two kinds of record rather than one: the records pointing `*.vault-sites.example.org` at the app, and an `_acme-challenge.vault-sites` record proving you control the name. `fly certs show '*.vault-sites.example.org' -a my-vault-name` prints the challenge target again if you need to look it up later.

Then tell the vault to use it. This is a setting rather than a deployment, so it is one command from your own machine, against the running vault:

```bash
cofferdam config set --sites-host vault-sites.example.org
cofferdam config view                                    # what the vault thinks now
```

Every reader of that setting consults `config.json` per request, so it is in effect on the next one and no restart is involved. `cofferdam config set --sites-host ''` puts sites back on the vault's own hostname under the sandbox, equally immediately, which is what makes this safe to try: if the certificate turns out not to cover what you thought, one command undoes it.

Set it only once the wildcard resolves to the vault and its certificate is issued. Sites stop being served on the forge hostname the moment it is set, redirecting to the new origin instead, so setting it early means sites that are unreachable until DNS catches up rather than sites that are merely still sandboxed. A value that is not a plausible hostname is refused by the command rather than stored, so a typo costs you a message and not an outage.

This is one Fly app with two hostnames, not two apps. Sites hosts must differ per vault in any case, because two Fly apps cannot hold a certificate for the same hostname.

A Cloudflare-specific trap, if that is your DNS provider, since it produces a certificate error rather than a clear failure: every record for these names must be **DNS only** rather than proxied. Universal SSL covers `example.org` and `*.example.org` only, one label deep, so a proxied `*.vault-sites.example.org` is not covered without Advanced Certificate Manager, and proxied wildcard DNS records are an Enterprise feature. Leaving them unproxied means no Cloudflare caching or WAF in front of the vault. Note also that a wildcard does not match the bare `vault-sites.example.org`, so that name needs its own record and certificate if it is ever to answer; without one it simply does not resolve, and the vault answers a minimal 404 on it if it does.

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

Updating a vault hosted this way is a pull and a recreate, and unlike the Fly deployment it can be made to happen on its own. Point the service at a published image rather than at the checkout, by replacing `build: .` with `image: ghcr.io/magland/cofferdam:latest`, and put a container updater beside it:

```yaml
  watchtower:
    image: containrrr/watchtower
    restart: unless-stopped
    command: --cleanup --interval 86400
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
```

That is a genuine automatic update rather than a deploy on a timer, and the reason it can be one here is that a Fly machine pins the digest its deploy resolved where a `latest` tag on a host of your own is resolved again every time the container is recreated. It costs the same restart of the vault, and it costs handing the Docker socket to a container, which is root on the host under another name. On a machine that does anything else, `docker compose pull && docker compose up -d` from a systemd timer is the same effect without that trade. [Updating on a schedule](#updating-on-a-schedule) is the equivalent for a vault on Fly.

Backing up a vault is copying a directory, and moving it to another host is copying it there, on a machine you have a shell on. On a Fly volume you have neither a shell in the ordinary sense nor rsync at the far end, so `cofferdam backup <dir>` pulls the copy over HTTP instead, incrementally, into a directory that is itself a servable vault: see [Backing up a vault](backup.md). It works the same way against a machine of your own, and is worth preferring there too, since it moves only what changed. Note that a vault on the open internet is readable by anyone, so say so in your own deployment notes.

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
