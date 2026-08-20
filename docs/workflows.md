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

The expression functions are `contains`, `startsWith`, `endsWith`, `format`, `join`, `toJSON`, `fromJSON`, `success`, `failure`, `always`, and `cancelled`. `hashFiles` is the one GitHub has that cofferdam does not, since it exists to key a cache that is also not here.

A job's `timeout-minutes` is enforced by the runner rather than by the vault, which is what makes it useful: the vault's lease sweep notices a runner that has stopped reporting, and a job wedged inside a step keeps reporting perfectly well. When the deadline passes the runner removes the job's container, which fails the step that was running, and the job concludes as a failure. Note that `timeout-minutes` on an individual step is accepted and then ignored, since stopping one step means stopping a process inside a container that the rest of the job still needs.

Within a step: `run` with `shell` and `working-directory`, the file commands (`GITHUB_OUTPUT`, `GITHUB_ENV`, `GITHUB_PATH`, `GITHUB_STEP_SUMMARY`), and the stdout commands (`::group::`, `::error::`, `::add-mask::` and friends). Values passed to `::add-mask::` are redacted from every later log line, on the runner, before the line is sent to the vault.

Steps that `use:` an action run too. JavaScript actions and composite actions work, nested to any depth, with their `pre` and `post` scripts; actions are fetched from github.com as source tarballs and cached on the runner. Any `runs.using: node<N>` is accepted rather than a fixed list of versions, so `node12` and `node18` run as `node20` and `node24` do: an action bundle is transpiled to a conservative target, so the runner uses the container image's own node when it is at or above the version asked for, and otherwise provisions that major version and says in the log that it did. A local action (`uses: ./.github/actions/thing`) comes from the repository being built. Docker actions (`runs.using: docker`) are not implemented and fail the step with a message saying so, as do reusable workflows, `container:` jobs, and `services:`.

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

### Three divergences worth knowing

`repository:` on `actions/checkout` names a repository *in this vault*, since `github.server_url` is the vault rather than github.com. A workflow copied from GitHub that pulls in a second repository this way fails with "repository not found", and the log says what has happened and what to do instead: check the other repository out with git, which reaches wherever it is pointed.

```yaml
      - name: Clone the library it builds against
        run: git clone --depth 1 --branch main https://github.com/someone/library.git library
```

cofferdam checks the repository out into the workspace before the job starts. On GitHub the workspace begins empty and `actions/checkout` fills it, and cofferdam's `checkout` is a re-sync of what is already there. A workflow that deliberately wants an empty workspace will be surprised.

A site is served at `/<collection>/<repo>/site/`, while GitHub serves one at `<owner>.github.io/<repo>/`, and on a vault with a [sites hostname](sites.md) it is served at the root of an origin of its own instead. A site generator that reads `base_path` from `configure-pages` gets the right answer in every case, because the vault decides it and hands it to the job; one that computes its own from the repository name gets GitHub's shape and produces broken links. Pass the base path explicitly in that case, or have the generator emit relative URLs. Note that `configure-pages` therefore has to run *before* the build that uses it, which is the opposite of where a workflow copied from GitHub usually puts it.

### Running actions needs node in the container

JavaScript actions need a node interpreter inside the job's container. If the image has one new enough, that one is used and nothing is downloaded, which is the usual case for CI images. Otherwise the runner downloads the official build once, caches it, and mounts it read-only into every container, so a bare `ubuntu:24.04` runs `actions/checkout` too. Those builds are linked against glibc, so a musl image (Alpine) needs node in the image; the runner says so rather than failing obscurely.

### Runners

A runner is registered against the vault and holds a token of its own, distinct from any user's:

```bash
cofferdam runner add laptop --allow 'mycollection/*' --labels ubuntu-latest
```

`--allow` takes globs over `collection/repo` and is the security boundary that matters: **a runner executes whatever those repositories' workflows contain, on the machine you start it on.** Registering one requires admin scope over exactly the globs being granted, the same rule that governs handing out push access. Grant a runner the repositories you would let run code on that machine, and no more. Docker is isolation against accidents, not against someone who wants your laptop.

The token is shown once, and only its hash is stored, as with user tokens. `--save` writes it to `~/.config/cofferdam/runner.json` (mode 0600) so later runs need no arguments. Registration is also available under **Admin > Runners** in the web interface, where each runner also has a page of its own showing its labels, the repositories it serves, whether the vault has heard from it, and the job it is running now.

Because only the hash is kept, a token that has been lost cannot be recovered, and the honest answer is to issue a new one. **Regenerate token** on a runner's page does that, keeping the runner's labels and allow list and printing the full `cofferdam runner run` command to start it with. The old token stops working the moment the new one is issued, so a runner already running with it will start failing to poll and has to be restarted.

Running one:

```bash
cofferdam runner run                        # using the saved configuration
cofferdam runner run --labels ubuntu-latest --image ubuntu-latest=ghcr.io/me/ci:latest
```

The runner long-polls for a job, so it needs no inbound connectivity and works behind NAT and through any ordinary HTTP proxy. It takes one job at a time, runs the whole job in a single container (steps `exec` into it, so what one step installs is there for the next), streams logs back as it goes, and reports the result. Ctrl-C finishes the current job and stops.

Job workspaces are made under the system temporary directory, which `--work-dir` changes, and the container joins Docker's default network unless `--network` names another. `COFFERDAM_RUNNER_TOKEN` supplies the runner's token where a command line is the wrong place for it, as in a systemd unit or a container.

Actions named by `uses:` are downloaded from `https://github.com` and cached under `~/.cache/cofferdam`, which `--actions-url` and `--cache-dir` change. The ref is resolved to a commit first, with one `git ls-remote`, and the cache entry is keyed by that commit: a branch or tag that has moved is picked up on the next run, and one that has not is never downloaded again. The log says which commit an action resolved to and whether the copy came from the cache, so a run that used an old copy is not mistaken for one that used the tip. A forge that cannot answer `ls-remote` falls back to keying by name and re-fetching after a day, and says so. `--no-action-cache` downloads every time.

`runs-on` labels map to images. The defaults cover `ubuntu-latest`, `ubuntu-24.04`, `ubuntu-22.04`, and `self-hosted` with the [`catthehacker`](https://github.com/catthehacker/docker_images) images that `act` also uses; `--image <label>=<image>` overrides any of them, and an unmapped label that looks like an image name (`runs-on: node:24`) is used as one. Note that the images decide what your workflows can assume: a bare `ubuntu:24.04` has no node, no python, and no compilers.

If the runner dies mid-job, the server notices the lease expire and requeues the job; after three attempts it fails it with a message naming the runner, rather than retrying forever. A failure in the runner itself rather than in the workflow, such as a work directory that has been removed underneath it, is logged against the run naming the runner, the machine it is on, and the directory it was working in, since none of that is visible to whoever is reading the run.

### A runner that stops when it is idle

A runner left running costs whatever its machine costs, all day, to execute a few minutes of work. That is the right trade for a machine you own and the wrong one for a machine billed by the minute, so a runner can be told to stop instead:

```bash
cofferdam runner run --idle 5m --wake-port 3000
```

With `--idle`, the runner exits when no job has arrived for that long, measured from the end of the last job rather than from the last poll. Whatever supervises it then stops paying for it: a Fly machine whose process exits is stopped, a systemd unit with `Restart=no` stays down.

The difficulty is what happens next. A runner reaches the vault and never the other way round, which is what lets one sit behind NAT with nothing open, and it also means a runner that has stopped cannot be told that work has arrived. So a runner may carry a *wake address*, and the vault sends a request to it when a job is waiting:

```bash
cofferdam runner wake myrunner --wake-url https://my-runner.fly.dev/wake
```

The request carries a shared secret and nothing else, and expects nothing back. What acts on it is whatever sits in front of the runner: Fly's proxy starts a stopped machine in order to deliver a request to it, and a systemd socket unit starts a service the same way. The runner's own `--wake-port` listener answers it, and refuses one that does not carry the secret, since starting a machine costs its owner money.

The vault sends a wake at most once a minute per runner, however many jobs are waiting, and only when that runner has not been heard from and one of the queued jobs matches its labels and its allow globs. It keeps trying for as long as the job sits there, so a wake lost to a network blip, or one that arrives in the second the runner was exiting, costs a minute rather than a run.

Two things follow from this arrangement that are worth saying plainly. A runner in the stopped state is not a fault: it is the arrangement working, and `cofferdam runner list` says "woken on demand" rather than reporting it as absent. And the first job after a stop waits for a boot, which on a Fly machine with a Docker daemon to start is around half a minute; jobs that follow it do not. `cofferdam runner wake <name>` sends the request by hand and reports how long the runner took to answer, which is the way to test an address without queuing a job.

The wake secret is stored in `runners.json` as the vault sends it, not as a hash. It is the opposite of a runner token: a credential the vault presents to somebody else rather than one it checks, and it buys nothing but the right to start a machine that will then ask for work in the ordinary way.

### A runner on Fly.io

`cofferdam deploy fly runner` puts all of the above on Fly in one command, beside a vault that is already there or anywhere else:

```bash
cofferdam deploy fly runner my-runner --allow 'mycollection/*'
```

It registers the runner with the vault you are logged in to, creates the app and a volume, hands the machine the vault URL and its token as Fly secrets, points the vault's wake request at the app, and deploys an image with a Docker daemon inside it. Afterwards the machine runs jobs and then stops, and the vault starts it again; between runs the app costs its volume alone, which is about three dollars a month for the default 20GB.

The volume is mounted at `/var/lib/docker`, which is what makes stopping affordable: an image pulled for a job stays pulled, so a cold start is a boot rather than a download.

Defaults are `shared-cpu-2x` with 2GB, a 20GB volume, and `--idle 5m`; `--vm-size`, `--vm-memory`, `--volume`, and `--idle` change them, and a redeploy keeps whatever the live app has for anything you do not name, so one flag changes one thing. `--allow` is required the first time and cannot be changed by a later deploy: changing what a runner serves means removing the registration and making it again, since it is the security boundary rather than a setting.

```bash
cofferdam deploy fly runner show my-runner       # what Fly has, and which runner it serves
cofferdam deploy fly runner destroy my-runner    # the app, and the registration with it
```

A runner deployed this way is a runner like any other: it executes whatever the repositories in its allow list contain, now on a machine in your Fly organization rather than on your laptop.

### Is a runner actually there?

A run that sits at `queued` has two usual causes, and `cofferdam runner list` reports both:

```
$ cofferdam runner list
laptop  labels: ubuntu-latest  serving: demo/*  running demo/ci #12 build
shed    labels: macos-14       serving: *       idle, seen 4m ago

1 job waiting for a runner:
  other/app #3 build  (runs-on: windows-latest)

No registered runner can take them: check the runs-on labels against each
runner's labels, and the repository against its serving globs.
```

"Seen" is when that runner last spoke to the vault, which a runner does every few seconds whether it has work or not; a runner that has not been seen is not running, or cannot reach the vault. The vault keeps this in memory rather than in `runners.json`, so a restart forgets it and every live runner re-announces itself within one poll. `--json` gives the same thing as data, with `lastSeen`, `running`, and the `queued` list.

### Runs in the vault

Run state is files, like everything else:

```
<vault>/collections/mycollection/repos/myrepo.runs/
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
