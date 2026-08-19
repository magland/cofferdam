# cofferdam

cofferdam is a self-hosted git forge with the shape of GitHub: repository browsing, in-browser editing, issues, pull requests, releases, GitHub Actions workflows, static sites, and Git LFS, over anonymous `git clone` and token-authenticated `git push`. It is one Node process that needs nothing installed beside it but git, and it runs the same on a laptop, a home server, a VPS, or a container platform. Reading is anonymous; every write is authorized by a token you minted, and the users who hold those tokens are created by an administrator of the vault rather than registering themselves.

Repositories are grouped into *collections*, and one installation, holding any number of collections, is a *vault*. A vault is a single directory that you point the server at, so an installation is created by choosing a directory and backed up by copying it. A vault is self-contained: users, permissions, and issue and pull request numbers are local to it, and it knows nothing of any other vault.

## Getting started

There are three points at which cofferdam becomes useful, and each is a small step from the one before. [Getting started](docs/getting-started.md) walks all three.

**1. A vault on your own machine.** Two commands, no account anywhere, and nothing written outside the directory you name:

```bash
mkdir myvault
npx @magland/cofferdam serve myvault
```

Finding no `vault.json`, the server initializes one and prints an owner token once; save it, since only its hash is stored. Open http://127.0.0.1:3000, sign in at `/login` as `owner` with that token, and push something in. The push creates the repository, and the collection holding it:

```bash
cd ~/some/project
git push http://127.0.0.1:3000/alice/myproject main   # username 'owner', password the token
```

**2. A vault on the internet.** The same server with a persistent disk and TLS in front. With a [Fly.io](https://fly.io) account and flyctl installed, one command creates the app, the volume, and the machine, and prints the owner token:

```bash
npm install -g @magland/cofferdam
cofferdam deploy fly my-vault-name       # -> https://my-vault-name.fly.dev
cofferdam login https://my-vault-name.fly.dev
cofferdam user add alice --scope 'alice/*'
```

That is a vault anyone can read, only your users can write, and you can send someone a link to. The same command deploys updates. See [Deploying a vault](docs/deploying.md) for the flags, the costs, and for hosting the container yourself instead.

**3. A domain of your own.** Worth doing once the vault is something you mean to keep: the URL stops naming the host it happens to run on, and each repository's static site can be given a hostname of its own instead of sharing the vault's under a sandbox. That part is DNS records and certificates, in [A domain of your own](docs/deploying.md#a-domain-of-your-own).

## What it does

- **Browsing.** Files and directories at any branch or tag, syntax highlighting, markdown rendered with GitHub's feature set including KaTeX math, commit history, diffs, blame, comparison of two revisions, literal search, a file finder, contributors, a language breakdown, and source archives. All of it anonymous.
- **Editing in the browser.** Create and edit files, upload binaries, manage branches and tags, create repositories and collections, fork within a vault, and administer users. Every control is gated by what the signed-in token may do, and one a user cannot use is not shown.
- **Issues and pull requests,** stored as markdown files in the vault. A pull request is merged as a merge commit or a squash, computed in the bare repository and refused on conflicts.
- **Releases** attached to a tag, with the source archives as their downloads, and Atom feeds for releases and for any history.
- **Workflows.** GitHub Actions workflows, planned by the server and executed by a runner you start elsewhere with Docker.
- **Sites.** A static site per repository, published by a workflow or by copying files in. Sandboxed by default so a site's script cannot act as a signed-in visitor, and optionally given a hostname of its own.
- **Git.** Anonymous `git clone` over smart HTTP, token-authenticated `git push` including push-to-create, and Git LFS with objects in an S3-compatible bucket or inside the vault.
- **A CLI and a JSON API** covering everything the web interface can do: repositories, files and commits, issues, pull requests, releases, workflow runs, users, and the vault's own settings, with a generic `cofferdam api` for anything a typed command has not reached. Meant to be usable by a program: `--json` everywhere, distinct exit codes, and nothing that prompts.

The frontend has no build step and no client framework: the server renders plain HTML, with small amounts of vanilla JavaScript where a control needs it.

## The vault

A vault is a plain directory. Each subdirectory of it is a collection, and each subdirectory of a collection is a bare git repository; everything else a repository accumulates sits beside it under a suffixed name:

```
<vault>/
  vault.json              (users and hashed tokens; created on first start)
  alice/
    webapp.git/           (bare repository)
    webapp.site/          (its static site)
    webapp.issues/        (its issues, one directory each)
    webapp.pulls/         (its pull requests)
    webapp.releases/      (its release notes, one file per tag)
    webapp.runs/          (its workflow runs and logs)
    webapp.lfs/           (its Git LFS objects, when no bucket is configured)
```

There is no database and no state outside this directory, so backing up a vault is `cp -a` and moving one to another machine is `rsync`. The server reads what is on disk on every request, so each part of a vault can be read, written, and grepped with ordinary tools while it runs. [The vault](docs/vault.md) describes the layout in full.

## Documentation

- [Getting started](docs/getting-started.md): a local vault, a vault on the internet, and a domain of your own
- [The vault](docs/vault.md): the layout on disk, and how signing in relates to the tokens git uses
- [The command line](docs/cli.md): the `cofferdam` command, `cofferdam login`, pushing, importing, and the commands over repositories, issues, pull requests, releases, and runs
- [Deploying a vault](docs/deploying.md): `cofferdam deploy fly`, a domain of your own, Docker, and automatic HTTPS with Caddy
- [Workflows](docs/workflows.md): what runs today, runners, artifacts, and the divergences from GitHub
- [Git LFS](docs/lfs.md): storage backends, bucket configuration, and limitations
- [The JSON API](docs/api.md): every route, its body, its response, and what it requires of the caller
- [cofferdam for an agent](docs/agents.md): short enough to paste into a context window, including an honest list of what is not there
- [Issues and pull requests](docs/issues-and-pull-requests.md), [Sites](docs/sites.md), [Themes](docs/themes.md)

## Development

```bash
npm install
npm run example    # creates example-root/ with sample collections, repositories, and a dev user
npm run dev        # serves example-root/ at http://127.0.0.1:3000
npm run smoke      # end to end: browsing, sessions, UI operations, the API, git over HTTP
```

The example vault includes a user `dev` with the fixed token `cofferdam_example_dev_token` (full push and admin scope, example vault only) and a read-only `reader` with `cofferdam_example_reader_token`. The smoke test leaves out one thing, executing workflow jobs in containers, which needs Docker and takes minutes where the rest takes seconds; `npm run smoke:slow` includes it.

## Roadmap

- Secrets, and a scoped token for the run, so a workflow can push back to its own repository and call the vault's API
- `actions/cache`, so dependency installs stop being repeated on every run
- Docker actions, `container:` jobs, and service containers

## License

Apache License 2.0. See [LICENSE](LICENSE).
