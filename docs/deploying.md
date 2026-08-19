# Deploying a vault

A remote vault is the same server with a persistent disk and TLS in front; there is nothing else to it, since the vault directory is the entire state. On first start the server initializes the vault and prints the owner token; from then on all administration happens from your own machine, on the web or through the CLI after `cofferdam login`.

The quickest route to a vault on the internet is `cofferdam deploy fly`, below, which needs no machine of your own and no checkout of this repository. Everything after it is for hosting the same container yourself.

## Fly.io, in one command

Fly.io runs the container for you, and the CLI can put it there. Install [flyctl](https://fly.io/docs/flyctl/install/), run `fly auth login` once, then:

```bash
cofferdam deploy fly my-vault-name
```

Fly app names are globally unique and the name becomes the URL, so pick your own. That creates the app, a 10GB volume, and a single machine serving the vault over HTTPS at `https://my-vault-name.fly.dev`, and finishes with you logged in:

```
==> Creating 'my-vault-name' in ewr
==> Creating a 10GB volume 'vault' in ewr
==> Setting the one-time owner token as a Fly secret
==> Deploying ghcr.io/magland/cofferdam:0.2.0
==> Waiting for the vault to answer

==> Ready: https://my-vault-name.fly.dev

Logged in as 'owner'.
```

There is no token to copy out of a log. The CLI mints the owner token on your machine, sets it as the `COFFERDAM_OWNER_TOKEN` secret, and the server adopts it when it initializes the empty vault, storing only its hash; the deploy then verifies it against the running server and hands it to git's credential store, exactly as `cofferdam login` would. So `cofferdam whoami`, `cofferdam user add`, and `git push` all work the moment the command returns. The secret stays set and is ignored on every later start, since a vault is initialized once.

Note that this needs a credential helper configured, as any login does. Without one the deploy still succeeds and prints the token, with the `cofferdam login --helper` line to store it (see [Not typing the token every time](cli.md#not-typing-the-token-every-time)).

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
cofferdam deploy show my-vault-name
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

`cofferdam deploy destroy my-vault-name` removes the app, the volume, and with them the vault; it asks you to type the app name first, and also drops the stored credential for a vault that no longer exists. Anything else is flyctl's job, and flyctl is already on your machine: `fly logs -a my-vault-name`, `fly ssh console -a my-vault-name`, `fly certs add vault.example.org` for a domain of your own.

### LFS objects in a bucket

By default Git LFS objects live on the volume with everything else, which is the simplest arrangement and the easiest to back up. Passing `--lfs-bucket` on a deploy provisions a Tigris bucket instead:

```bash
cofferdam deploy fly my-vault-name --lfs-bucket
```

Tigris' secrets are the ones the server already reads, so there is nothing further to configure (see [Git LFS](lfs.md)). Note that this provisions a billable resource in your Fly organization, and that `deploy destroy` leaves the bucket alone: destroying it, and its contents, is `fly storage destroy <name>`.

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
