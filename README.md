# cofferdam

A self-hosted git forge, GitHub-shaped: repository browsing, in-browser editing, issues, pull requests, releases, Actions-style workflows, static sites, and Git LFS. One Node process, no database, nothing installed beside it but git.

Reading is anonymous. Every write is authorized by a token, and users are created by an administrator rather than registering themselves.

## Try it locally

```bash
mkdir myvault
npx @magland/cofferdam serve myvault
```

The server initializes the vault and prints an owner token once (only its hash is stored). Open http://127.0.0.1:3000, sign in at `/login` as `owner`, then push a repository in - the push creates it:

```bash
cd ~/some/project
git push http://127.0.0.1:3000/alice/myproject main   # user 'owner', password the token
```

## Put it on the internet

With a [Fly.io](https://fly.io) account and flyctl installed, one command creates the app, the volume, and the machine:

```bash
npm install -g @magland/cofferdam
cofferdam deploy fly my-vault-name       # -> https://my-vault-name.fly.dev
cofferdam login https://my-vault-name.fly.dev
cofferdam user add alice --scope 'alice/*'
```

The same command deploys updates. See [Deploying a vault](docs/deploying.md) for Docker, self-hosting, costs, and giving the vault a domain of your own.

## What it does

- **Browsing:** files at any ref, syntax highlighting, markdown with KaTeX, history, diffs, blame, compare, search, contributors, archives. Anonymous. A collection introduces itself with a profile README, from a `.cofferdam` repository in it.
- **Editing in the browser:** files, uploads, branches, tags, repositories, collections, forks, users. Controls a token cannot use are not shown.
- **Issues and pull requests,** stored as markdown in the vault. Merge or squash, refused on conflicts.
- **Releases** tied to a tag, with Atom feeds.
- **Workflows:** GitHub Actions workflows, planned by the server and run by a Docker runner you start elsewhere, including one deployed to Fly.io with a command, which stops when idle and is woken by the vault when a job is queued.
- **Sites:** a static site per repository, sandboxed by default, optionally on its own hostname.
- **Git:** anonymous clone over smart HTTP, token-authenticated push including push-to-create, and LFS to S3 or to the vault.
- **CLI and JSON API** covering everything the web UI does, plus a generic `cofferdam api`. Built for scripts: `--json` everywhere, distinct exit codes, no prompts.

The frontend has no build step and no client framework: plain server-rendered HTML with a little vanilla JavaScript.

## The vault

A vault is one directory. Repositories are grouped into *collections*; a vault holds any number of them and knows nothing of any other vault.

```
<vault>/
  vault.json                  users and hashed tokens
  config.json                 vault settings
  collections/
    alice/
      repos/
        webapp.git/           bare repository
        webapp.site/          its static site
        webapp.issues/        .pulls/ .releases/ .runs/ .lfs/
```

No database, no state outside the directory. Backup is `cp -a`, migration is `rsync`, and `cofferdam backup <dir>` pulls the same copy over HTTP where you have no shell. The server reads disk on every request, so a running vault can be read and grepped with ordinary tools.

## Documentation

- [Getting started](docs/getting-started.md) - a local vault, a public one, and a domain of your own
- [The command line](docs/cli.md) - the `cofferdam` command and its subcommands
- [The vault](docs/vault.md) - the on-disk layout, tokens, and sessions
- [Deploying a vault](docs/deploying.md) | [Backing up a vault](docs/backup.md)
- [Workflows](docs/workflows.md) | [Sites](docs/sites.md) | [Git LFS](docs/lfs.md) | [Themes](docs/themes.md) | [Issues and pull requests](docs/issues-and-pull-requests.md)
- [The JSON API](docs/api.md) - every route, body, and response
- [cofferdam for an agent](docs/agents.md) - short enough to paste into a context window

## Using a vault from Claude Code

[cofferdam-skill](https://github.com/magland/cofferdam-skill) teaches an agent this CLI the way it already knows `gh`.

```
/plugin marketplace add magland/cofferdam-skill
/plugin install cofferdam@cofferdam-skill
```

The agent needs `cofferdam` on its PATH and either `COFFERDAM_HOST`/`COFFERDAM_TOKEN` or a completed `cofferdam login`.

## Development

```bash
npm install
npm run example    # creates example-root/ with sample data and a dev user
npm run dev        # serves example-root/ at http://127.0.0.1:3000
npm run test:unit  # the pure modules, in milliseconds
npm run smoke      # end to end; npm run smoke:slow adds containerized workflow jobs
```

The example vault has user `dev` with token `cofferdam_example_dev_token` (full scope, example vault only) and read-only `reader` with `cofferdam_example_reader_token`.

## Roadmap

- Secrets, and a scoped token so a workflow can push to its own repository and call the API
- `actions/cache`
- Docker actions, `container:` jobs, and service containers

## License

Apache License 2.0. See [LICENSE](LICENSE).
