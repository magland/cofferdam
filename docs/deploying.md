# Deploying a vault

A remote vault is the same server with a persistent disk and TLS in front; there is nothing else to it, since the vault directory is the entire state. On first start the server initializes the vault and prints the owner token to the logs; from then on all administration happens from your own machine, on the web or through the CLI after `cofferdam login`.

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

Without a server of your own, the same container runs on Fly.io. After `fly auth login`, one command does everything:

```bash
./scripts/deploy-fly.sh my-vault-name
```

That creates the app and a volume, deploys a single machine, and prints the one-time owner token together with the `cofferdam login` line to run with it. Pick your own name, since Fly app names are globally unique. Re-running it deploys an update, reusing the existing app and volume.

By hand, the same thing is:

```bash
fly apps create my-vault-name
fly volumes create vault --app my-vault-name --region ewr --size 10 --yes
fly deploy --app my-vault-name --ha=false
fly logs --app my-vault-name
```

Passing `--app` on each command overrides the placeholder name in `fly.toml`, so there is nothing to edit. Note `--ha=false`: a vault is a directory on a single volume, so this app must run as one machine. Two machines would mean two volumes and two vaults that silently diverge. For the same reason, scaling up means a bigger machine rather than more of them.

The server honors `X-Forwarded-*` headers, so clone URLs, cookies, and the web UI behave correctly behind any of these proxies.

Backing up a vault is copying a directory. Moving it to another host, or from your laptop to the cloud, is copying it there. Note that rate limiting and abuse controls for public vaults are not implemented; a vault on the open internet is readable by anyone, so say so in your own deployment notes.
