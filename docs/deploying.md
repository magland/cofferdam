# Deploying a vault

A remote vault is the same server with a persistent disk and TLS in front; there is nothing else to it, since the vault directory is the entire state. On first start the server initializes the vault and prints the owner token; from then on all administration happens from your own machine, on the web or through the CLI after `cofferdam login`.

The quickest route to a vault on the internet is `cofferdam deploy fly`, below, which needs no machine of your own and no checkout of this repository. Everything after it is for hosting the same container yourself.

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

`cofferdam deploy fly destroy my-vault-name` removes the app, the volume, and with them the vault; it asks you to type the app name first (`--yes` skips the prompt, for a script that means it), and also drops the stored credential for a vault that no longer exists. Anything else is flyctl's job, and flyctl is already on your machine: `fly logs -a my-vault-name`, `fly ssh console -a my-vault-name`, `fly certs add vault.example.org` for a domain of your own.

### LFS objects in a bucket

By default Git LFS objects live on the volume with everything else, which is the simplest arrangement and the easiest to back up. Passing `--lfs-bucket` on a deploy provisions a Tigris bucket instead:

```bash
cofferdam deploy fly my-vault-name --lfs-bucket
```

Tigris' secrets are the ones the server already reads, so there is nothing further to configure (see [Git LFS](lfs.md)). Note that this provisions a billable resource in your Fly organization, and that `deploy fly destroy` leaves the bucket alone: destroying it, and its contents, is `fly storage destroy <name>`.

### Serving sites from their own hostname

By default a repository's static site is served from the vault's own hostname and sandboxed, which costs it cookies, storage, and service workers (see [Sites](sites.md)). Giving each site a real origin means a wildcard hostname and a certificate for it, which is DNS work rather than something the CLI can do.

For a vault at `vault1.magland.org` on a Fly app named `vault1`, with `magland.org` on Cloudflare:

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

The plain subdomain is validated over HTTP-01, which Fly can answer itself because requests for that name reach the app. A wildcard cannot be: there is no single name to answer for, so it needs DNS-01, which is why the third record exists and why `fly certs show` has to be run to learn what to put in it.

Then set the host in the vault's `config.json`, which is on the volume:

```json
{
  "sites": { "host": "vault1-sites.magland.org" }
}
```

This is one Fly app with two hostnames, not two apps. Sites hosts must differ per vault in any case, because two Fly apps cannot hold a certificate for the same hostname.

A Cloudflare-specific trap, since it produces a certificate error rather than a clear failure: Universal SSL covers `example.com` and `*.example.com` only, one label deep, so a proxied `*.vault1-sites.magland.org` is not covered without Advanced Certificate Manager, and proxied wildcard DNS records are an Enterprise feature. All three records stay DNS only, which means no Cloudflare caching or WAF in front of the vault. Note also that a wildcard does not match the bare `vault1-sites.magland.org`, so that name needs its own record and certificate if it is ever to answer; without one it simply does not resolve, and the vault answers a minimal 404 on it if it does.

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

The server honors `X-Forwarded-*` headers, so clone URLs, cookies, and the web UI behave correctly behind any of these proxies.

Backing up a vault is copying a directory. Moving it to another host, or from your laptop to the cloud, is copying it there. Note that rate limiting and abuse controls for public vaults are not implemented; a vault on the open internet is readable by anyone, so say so in your own deployment notes.
