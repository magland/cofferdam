# Workflows

GitHub Actions workflows, planned by the server and executed by a runner you start elsewhere.

A vault runs GitHub Actions workflows, with one deliberate difference: **jobs never execute on the machine serving the vault**. That machine holds repositories and answers HTTP; giving it a container runtime and letting pushed code run on it is the wrong shape for a small server, and worse for a shared one. Instead the server plans runs and hands them out, and a *runner* you start somewhere with Docker takes them:

```bash
cofferdam runner add laptop --allow 'mycollection/*'    # on any machine, with an admin token
cofferdam runner run --host https://vault.example.com --runner-token cofferdam_runner_...
```

A vault with no runner is not broken; its runs queue and wait, and the Actions tab says so. Start a runner and they go.

Workflows are read from two directories:

```
.cofferdam/workflows/*.yml     preferred
.github/workflows/*.yml     also read, so repositories work unchanged
```

Both are collected. A file in `.cofferdam/workflows` shadows one of the same name in `.github/workflows`, which is how a repository adapts a single workflow for cofferdam without forking the rest of them. The name has to match in full, extension included, so a `build.yml` here does not shadow a `build.yaml` there and both would run. The workflow syntax is GitHub's, the context is spelled `github`, and the environment variables are the `GITHUB_*` ones, because compatibility is the whole point of the layer.

### What runs today

Triggers are `push` (with `branches`, `tags`, and `paths` filters, plus their `-ignore` forms) and `workflow_dispatch` with typed inputs, which the Actions tab renders as a form. A commit made in the web interface is a push like any other and fires the same workflows.

Within a run: the `${{ }}` expression language, `needs` between jobs, `strategy.matrix` with `include`, `exclude`, and `fail-fast`, `if` on jobs and steps (including `always()`, `failure()`, and `cancelled()`), `env` at workflow, job, and step level, `concurrency` groups with `cancel-in-progress`, `continue-on-error`, `timeout-minutes` on a job, job `outputs`, and `defaults.run`.

A job's `timeout-minutes` is enforced by the runner rather than by the vault, which is what makes it useful: the vault's lease sweep notices a runner that has stopped reporting, and a job wedged inside a step keeps reporting perfectly well. When the deadline passes the runner removes the job's container, which fails the step that was running, and the job concludes as a failure. Note that `timeout-minutes` on an individual step is accepted and then ignored, since stopping one step means stopping a process inside a container that the rest of the job still needs.

Within a step: `run` with `shell` and `working-directory`, the file commands (`GITHUB_OUTPUT`, `GITHUB_ENV`, `GITHUB_PATH`, `GITHUB_STEP_SUMMARY`), and the stdout commands (`::group::`, `::error::`, `::add-mask::` and friends). Values passed to `::add-mask::` are redacted from every later log line, on the runner, before the line is sent to the vault.

Steps that `use:` an action run too. JavaScript actions (`node16`, `node20`, `node24`) and composite actions work, nested to any depth, with their `pre` and `post` scripts; actions are fetched from github.com as source tarballs and cached on the runner. A local action (`uses: ./.github/actions/thing`) comes from the repository being built. Docker actions (`runs.using: docker`) are not implemented and fail the step with a message saying so, as do reusable workflows, `container:` jobs, and `services:`.

Not implemented: secrets, `actions/cache` and the cache service, `hashFiles()`, and a token for the run (so an action that calls a forge API gets no credential, and one that needs it will say so). A matrix given as an expression rather than as literal values, typically `fromJSON` over a `needs` output, would have to be expanded when the job starts rather than when the run is planned; it is refused at planning time with a message saying so.

### Actions cofferdam implements itself

A few actions are not ordinary programs: they are clients for services that exist only inside GitHub. Running them verbatim against a vault cannot work, so cofferdam substitutes its own implementation of the same interface, chosen by the `uses:` string and applied at any nesting depth, including inside somebody else's composite action.

| `uses:` | What cofferdam does instead |
| --- | --- |
| `actions/checkout` | Reports the checkout the runner already made; does real work for another repository, ref, path, `fetch-depth: 0`, or submodules |
| `actions/upload-artifact` | Tars the matched paths and stores them in the run's directory in the vault |
| `actions/download-artifact` | Restores one, or all of the run's artifacts, into the workspace |
| `actions/configure-pages` | Reports this vault's site URL and base path, and exports `COFFERDAM_SITE_BASE_PATH` |
| `actions/deploy-pages` | Publishes the `github-pages` artifact as the repository's site |

Everything else runs unmodified, `actions/setup-node` and the rest included. Note that `actions/upload-pages-artifact` is *not* substituted: it is an ordinary composite action that tars a directory and calls `upload-artifact`, so the real one works as it is, on top of cofferdam's `upload-artifact`.

Substituting by name rather than implementing GitHub's artifact and Pages wire protocols is a deliberate trade: far less code, at the cost of following a handful of action interfaces as they change.

### Artifacts

`upload-artifact` stores a tar in the run's directory, `download-artifact` restores it in a later job of the same run, and the run page lists what was produced with a download link. Anonymous, like every other read in a vault. Artifacts are pruned with their run, and a job may not upload more than `ci.artifactMb` (500 MB by default).

Artifacts are addressed by the job's lease, so only a job that is actually running can write one, and only into its own run.

### Two divergences worth knowing

cofferdam checks the repository out into the workspace before the job starts. On GitHub the workspace begins empty and `actions/checkout` fills it, and cofferdam's `checkout` is a re-sync of what is already there. A workflow that deliberately wants an empty workspace will be surprised.

A site is served at `/<collection>/<repo>/site/`, while GitHub serves one at `<owner>.github.io/<repo>/`. A site generator that reads `base_path` from `configure-pages` gets the right answer; one that computes its own from the repository name gets GitHub's shape and produces broken links. Pass the base path explicitly in that case, or have the generator emit relative URLs.

### Running actions needs node in the container

JavaScript actions need a node interpreter inside the job's container. If the image has one new enough, that one is used and nothing is downloaded, which is the usual case for CI images. Otherwise the runner downloads the official build once, caches it, and mounts it read-only into every container, so a bare `ubuntu:24.04` runs `actions/checkout` too. Those builds are linked against glibc, so a musl image (Alpine) needs node in the image; the runner says so rather than failing obscurely.

### Runners

A runner is registered against the vault and holds a token of its own, distinct from any user's:

```bash
cofferdam runner add laptop --allow 'mycollection/*' --labels ubuntu-latest
```

`--allow` takes globs over `collection/repo` and is the security boundary that matters: **a runner executes whatever those repositories' workflows contain, on the machine you start it on.** Registering one requires admin scope over exactly the globs being granted, the same rule that governs handing out push access. Grant a runner the repositories you would let run code on that machine, and no more. Docker is isolation against accidents, not against someone who wants your laptop.

The token is shown once, and only its hash is stored, as with user tokens. `--save` writes it to `~/.config/cofferdam/runner.json` (mode 0600) so later runs need no arguments. Registration is also available under **Admin > Runners** in the web interface.

Running one:

```bash
cofferdam runner run                        # using the saved configuration
cofferdam runner run --labels ubuntu-latest --image ubuntu-latest=ghcr.io/me/ci:latest
```

The runner long-polls for a job, so it needs no inbound connectivity and works behind NAT and through any ordinary HTTP proxy. It takes one job at a time, runs the whole job in a single container (steps `exec` into it, so what one step installs is there for the next), streams logs back as it goes, and reports the result. Ctrl-C finishes the current job and stops.

Job workspaces are made under the system temporary directory, which `--work-dir` changes, and the container joins Docker's default network unless `--network` names another. `COFFERDAM_RUNNER_TOKEN` supplies the runner's token where a command line is the wrong place for it, as in a systemd unit or a container.

Actions named by `uses:` are downloaded from `https://github.com` and cached under `~/.cache/cofferdam`, which `--actions-url` and `--cache-dir` change. The ref is resolved to a commit first, with one `git ls-remote`, and the cache entry is keyed by that commit: a branch or tag that has moved is picked up on the next run, and one that has not is never downloaded again. The log says which commit an action resolved to and whether the copy came from the cache, so a run that used an old copy is not mistaken for one that used the tip. A forge that cannot answer `ls-remote` falls back to keying by name and re-fetching after a day, and says so. `--no-action-cache` downloads every time.

`runs-on` labels map to images. The defaults cover `ubuntu-latest`, `ubuntu-24.04`, `ubuntu-22.04`, and `self-hosted` with the [`catthehacker`](https://github.com/catthehacker/docker_images) images that `act` also uses; `--image <label>=<image>` overrides any of them, and an unmapped label that looks like an image name (`runs-on: node:24`) is used as one. Note that the images decide what your workflows can assume: a bare `ubuntu:24.04` has no node, no python, and no compilers.

If the runner dies mid-job, the server notices the lease expire and requeues the job; after three attempts it fails it with a message naming the runner, rather than retrying forever.

### Runs in the vault

Run state is files, like everything else:

```
<vault>/mycollection/myrepo.runs/
  12/
    run.json          the run: event, ref, sha, status, job order
    jobs/build.json   one per job: steps, start and finish times, outputs
    jobs/build.log    the log, one JSON object per line
```

Runs are the one part of a vault that grows without bound, so they are pruned. The defaults keep the last 100 completed runs per repository, apply no age rule, and cap a single artifact upload at 500 MB, which is `{ "runs": 100, "days": 0, "artifactMb": 500 }`. `config.json` tunes any of them:

```json
{ "theme": "paper", "ci": { "runs": 50, "days": 30, "artifactMb": 200 } }
```

That keeps fewer runs than the default, and also drops completed runs older than 30 days; `days` of `0`, the default, disables the age rule. Active runs are never pruned.
